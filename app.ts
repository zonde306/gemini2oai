import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerateContentResponse, GenerateContentParameters, ContentListUnion, CountTokensResponse, File } from "npm:@google/genai";
import { Buffer } from "node:buffer";
import _ from "npm:lodash";

const MAX_FILE_SIZE = 20 * 1000 * 1000; // 20MB, not Mib
const API_KEY = Deno.env.get("API_KEY") || "";
const TOKENS = (Deno.env.get("TOKENS") || "").split(",").map(x => x.trim()).filter(x => x.length > 0);
const db = await Deno.openKv();
let MODELS : ModelInfo[] = [];

class ResponseError extends Error {
    constructor(msg : string, opts = {}, ...params: undefined[]) {
        super(...params);
        this.name = "ResponseError";
        this.message = msg;
        // @ts-expect-error: 2339
        this.opts = opts;
    }

    get response() {
        // @ts-expect-error: 2339
        return new Response(this.message, this.opts);
    }
}

class ApiError extends Error {
}

function handleOptions(request: Request) {
    if(request.method === "OPTIONS") {
        throw new ResponseError("", {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
        });
    }
}

function getAccessTokens(request: Request) : string[] {
    const authorization = (request.headers.get("Authorization") || '').replace("Bearer ", "").trim();
    if(!authorization) {
        throw new ResponseError("Unauthorized", { status: 401 });
    }

    // 使用内置 API Key
    if(authorization === API_KEY) {
        if(TOKENS.length <= 0)
            throw new ResponseError("No API Key", { status: 400 });
        return TOKENS;
    }

    // 自己提供 API Key
    const api_key = authorization.split(",").map(x => x.trim()).filter(x => x.length > 0);
    if(api_key.length <= 0) {
        throw new ResponseError("No API Key", { status: 401 });
    }

    return api_key;
}

class GenerateServe {
    private _model : string;
    private _tokens : string[];
    private _stream : boolean = false;
    private _blacklist : Set<string> = new Set<string>();

    constructor(model: string, stream: boolean, tokens: string[]) {
        this._model = model;
        this._tokens = tokens;
        this._stream = stream;
    }

    // deno-lint-ignore no-explicit-any
    async serve(body: any) : Promise<Response> {
        if (body.fake_stream && this._stream)
            return await this.scheduleFakeStream(body);
        return await this.schedule(body);
    }

    // deno-lint-ignore no-explicit-any
    async schedule(body: any) : Promise<Response> {
        const headers = new Headers({
            "Content-Type": body.stream ? "text/event-stream" : "application/json",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });

        let result = null;
        for(let i = 0; i < this._tokens.length; i++) {
            const { token, generateParams, ep, total } = await this.prepareGenerate(body);
            console.log(`start ${i + 1} generation, tokens: ${total} with stream: ${this._stream}, choice: ${this._tokens.indexOf(token) + 1}/${this._tokens.length}`);

            try {
                if(this._stream)
                    result = await this.handleStream(ep, generateParams);
                else
                    result = await this.handleNonStream(ep, generateParams);
                break;
            } catch(e) {
                if (e instanceof ApiError) {
                    // 重试
                    this._blacklist.add(token);
                    result = e;
                    continue;
                }

                // @ts-expect-error: 18046
                return new Response(e.cause?.message || e.message, { status: 400 });
            }
        }

        if(result instanceof Error) {
            // @ts-expect-error: 18046
            return new Response(result.cause?.message || result.message, { status: 400 });
        }
        
        return new Response(result, { headers });
    }

    // deno-lint-ignore no-explicit-any
    async scheduleFakeStream(body: any) {
        const headers = new Headers({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
        });

        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
        const responseId : string = crypto.randomUUID();
    
        // 防超时用
        const keepAlive = setInterval(() => {
            writer.write(encoder.encode(`data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model: this._model,
                choices: [{
                    index: 0,
                    delta: {
                        role: "assistant",
                        content: "",
                    }
                }]
            })}\n\n`));
        }, 5000);

        // 后台运行
        (async() => {
            for(let i = 0; i < this._tokens.length; i++) {
                let lastToken = "";
                try {
                    const { token, generateParams, ep, total } = await this.prepareGenerate(body);
                    console.log(`start ${i + 1} generation, tokens: ${total} with fake stream, choice: ${this._tokens.indexOf(token) + 1}/${this._tokens.length}`);

                    // 仅用于黑名单
                    lastToken = token;

                    const response = JSON.parse(await this.handleNonStream(ep, generateParams));
                    writer.write(encoder.encode(`data: ${JSON.stringify({
                        id: responseId,
                        object: "chat.completion.chunk",
                        created: Date.now(),
                        model: this._model,
                        choices: [{
                            index: 0,
                            delta: {
                                role: "assistant",
                                content: response.choices[0].message.content,
                            },
                            finish_reason: response.choices[0].finish_reason,
                        }],
                        usage: response.usage,
                    })}\n\n`));

                    break;
                } catch(e) {
                    // 已知错误，可以重试
                    if (e instanceof ApiError) {
                        this._blacklist.add(lastToken);
                        continue;
                    }

                    // 无法重试
                    writer.write(encoder.encode(`data: ${JSON.stringify({
                        id: responseId,
                        object: "chat.completion.chunk",
                        created: Date.now(),
                        model: this._model,
                        choices: [{
                            index: 0,
                            delta: {
                                role: "assistant",
                                // @ts-expect-error: 18046
                                content: `ERROR: ${e.message}`,
                            },
                            finish_reason: "error",
                        }]
                    })}\n\n`));

                    break;
                }
            }

            clearInterval(keepAlive);
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            await writer.close();
        })();
    
        return new Response(readable, { headers });
    }

    // deno-lint-ignore no-explicit-any
    async prepareGenerate(body: any) {
        const token = await this.getNextToken();
        const ep = new GoogleGenAI({ apiKey: token });
        const { prompts, systemPrompt } = await this.formattingMessages(body.messages, ep);
        const generateParams = await this.prepareGenerateParams(body.model, prompts, { ...body, systemPrompt });
        let counter : CountTokensResponse;

        try {
            counter = await ep.models.countTokens(generateParams);
        } catch(e) {
            // 虽然不应该这样，但是不好处理
            this._blacklist.add(token);

            // @ts-expect-error: 18046
            throw new ApiError(`Invalid API Key for ${token}, error: ${e.message}`);
        }

        console.log(`[input] total ${counter.totalTokens} tokens used with model ${body.model}.`);
        const modelInfo = (await fetchModels(token)).find(x => x.id === body.model || x.name === body.model || x.displayName === body.model);
        if(!modelInfo || (counter.totalTokens && modelInfo.input && counter.totalTokens > modelInfo.input)) {
            throw new Error(`too may tokens for model ${body.model} (max: ${modelInfo?.input})`);
        }

        return { token, generateParams, ep, total: counter.totalTokens };
    }

    hash(s: string) : string {
        return String(s.split("").reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0));
    }

    async getNextToken() : Promise<string> {
        const avaiable = this._tokens.filter(x => !this._blacklist.has(x));
        if(avaiable.length <= 0) {
            throw new ResponseError("No avaiable Key", { status: 401 });
        }
        
        const now = Date.now();
        let usages : number[][] = [];
        const model = await fetchModels(avaiable[0]);
        const modelInfo = model.find(x => x.id === this._model || x.name === this._model || x.displayName === this._model);
        if(modelInfo == null) {
            throw new ResponseError(`Invalid model ${this._model}`, { status: 404 });
        }
        
        // db.getMany 上限为 10，超过则需要分批查询
        for(let i = 0; i < this._tokens.length / 10; i++) {
            const keys = this._tokens.slice(10 * i, 10 * (i + 1)).map(x => [ "gemini", "rpm", this._model, this.hash(x) ]);
            usages = usages.concat(
                (await db.getMany(keys)).map(x => x.value as number[] || []).map(x => x.filter(t => t > now))
            );
        }
        
        const usageIndexes = usages.map(x => x.length);
        // @ts-expect-error: 2339
        const index = usageIndexes.indexOf(_.min(usageIndexes));
        usages[index].push(now + 60 * 1000);
        await db.set([ "gemini", "rpm", this._model, this.hash(this._tokens[index]) ], usages[index], { expireIn: 60 * 1000 });
        return this._tokens[index];
    }

    async uploadLargeFile(data: string | Blob | ArrayBuffer, mime: string, ep: GoogleGenAI) : Promise<{ uri: string, mimeType: string }> {
        if(typeof data === "string")
            data = new Buffer.Blob([ Buffer.from(data, "base64").buffer ]);
        if(data instanceof ArrayBuffer)
            data = new Blob([ data ]);
        
        const file = await ep.files.upload({
            file: data,
            config: {
                mimeType: mime,
            }
        });

        // wait for file to be uploaded
        let fd : File | null = null;
        while(file.name) {
            fd = await ep.files.get({ name: file.name });
            if(fd.state !== "PROCESSING")
                break;

            await new Promise(resolve => {
                setTimeout(resolve, 1000);
            });
        }

        if(!fd || fd.state === "FAILED" || !fd.uri || !fd.mimeType) {
            throw new ResponseError("File upload failed", { status: 400 });
        }

        return {
            uri: fd.uri,
            mimeType: fd.mimeType,
        };
    }

    async uploadFile(urlOrData: string, ep: GoogleGenAI) : Promise<{ data: string, mime: string }> {
        if(urlOrData.startsWith("http") || urlOrData.startsWith("ftp")) {
            // URL
            const response = await fetch(urlOrData);
            const data = await response.arrayBuffer();
            const mime = response.headers.get("Content-Type") || "application/octet-stream";
            if(data.byteLength > MAX_FILE_SIZE) {
                const { uri, mimeType } = await this.uploadLargeFile(data, mime, ep);
                return {
                    data: uri,
                    mime: mimeType,
                };
            }
    
            return {
                data: Buffer.from(data).toString("base64"),
                mime: mime,
            };
        } else {
            // data:image/jpeg;base64,...
            const [ mime, data ] = urlOrData.split(";base64,", 2);
            const bolb = Buffer.from(data, "base64");
            if(bolb.byteLength > MAX_FILE_SIZE) {
                const { uri, mimeType } = await this.uploadLargeFile(bolb, mime, ep);
                return {
                    data: uri,
                    mime: mimeType,
                };
            }
            
            return {
                data: data,
                mime: mime.replace(/^data:/, ""),
            };
        }
    }

    processMessageContent(content: string, defaults?: FeatureInfo) : FeatureInfo {
        const feat : FeatureInfo = defaults || {
            role: {
                user: "Human",
                assistant: "Model",
                system: "System",
            },
            removeRole: false,
            systemPrompt: "",
            content: content,
        };
        feat.content = content;
    
        const roleInfo = /<roleInfo>([\s\S]*)<\/roleInfo>/.exec(feat.content);
        if(roleInfo) {
            feat.content = feat.content.replace(roleInfo[0], "");
            for(let line of roleInfo[1].split("\n")) {
                line = line.trim();
                if(!line || !line.includes(":"))
                    continue;
    
                const [ role, name ] = line.split(":");
                feat.role[role.trim().toLowerCase()] = name.trim();
            }
        }
    
        /*
        // systemInstruction parameter is not supported in Gemini API.
        const systemPrompt = /<systemPrompt>([\s\S]*)<\/systemPrompt>/.exec(feat.content);
        if(systemPrompt) {
            feat.content = feat.content.replace(systemPrompt[0], "");
            feat.systemPrompt = systemPrompt[1].trim();
        }
        */
    
        if(feat.content.includes("<|removeRole|>")) {
            feat.removeRole = true;
            feat.content = feat.content.replace("<|removeRole|>", "");
        }
    
        return feat;
    }

    async formattingMessages(messages: { role: string, content: unknown }[], ep : GoogleGenAI) : Promise<{ prompts: ContentListUnion, systemPrompt: string }> {
        const results : GeneratePrompt[] = [];
        let feat = this.processMessageContent("");
        for(const msg of messages) {
            if(Array.isArray(msg.content)) {
                for(const inner of msg.content) {
                    if(inner.type === "image_url" && inner.image_url) {
                        const { data, mime } = await this.uploadFile(inner.image_url.url, ep);
                        results.push({ mime: mime, data: data });
                    } else if(inner.type === "text" && inner.text) {
                        feat = this.processMessageContent(inner.text, feat);
                        results.push({ text: feat.removeRole ? feat.content : `${feat.role[msg.role]}: ${feat.content}` });
                    } else {
                        console.error("unknown content type", inner);
                        throw new ResponseError("Unknown content type", { status: 422 });
                    }
                }
            } else if (typeof msg.content === "string") {
                feat = this.processMessageContent(msg.content, feat);
                results.push({ text: feat.removeRole ? feat.content : `${feat.role[msg.role]}: ${feat.content}` });
            } else {
                console.error("unknown content type", msg.content);
                throw new ResponseError("Unknown content type", { status: 422 });
            }
        }
    
        return {
            // @ts-expect-error: 2339
            prompts: results.map(x => _.merge(
                {},
                x.text ? { text: x.text } : {},
                x.mime && x.data ? { inlineData: { mimeType: x.mime, data: x.data } } : {}
            )),
            systemPrompt: feat.systemPrompt,
        };
    }

    async prepareGenerateParams(model: string, prompts: ContentListUnion, options: GenerateOptions = {}) : Promise<GenerateContentParameters> {
        const modelConfig = (await fetchModels("")).find(x => x.id === model || x.name === model || x.displayName === model);
        if(!modelConfig)
            throw new ResponseError("Model not found", { status: 404 });
        
        return {
            model: model,
            contents: prompts,
            config: {
                // 禁用审查
                safetySettings: [
                    {
                        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                        threshold: HarmBlockThreshold.OFF,
                    },
                    {
                        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                        threshold: HarmBlockThreshold.OFF,
                    },
                    {
                        category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                        threshold: HarmBlockThreshold.OFF,
                    },
                    {
                        category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                        threshold: HarmBlockThreshold.OFF,
                    },
                    {
                        category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
                        threshold: HarmBlockThreshold.OFF,
                    },
                ],
                temperature: options.temperature,
                topP: options.top_p,
                maxOutputTokens: Math.min(options.max_tokens || modelConfig.output, modelConfig.output),
                topK: options.top_k,
    
                /*
                // 这些参数都不支持
                frequencyPenalty: options.frequency_penalty,
                presencePenalty: options.presence_penalty,
                systemInstruction: options.systemPrompt,
                */
    
                // 只有部分模型支持的参数
                ...(options.include_reasoning ? { includeThoughts: true } : {}),
            }
        };
    }

    async handleStream(ep: GoogleGenAI, generateParams: GenerateContentParameters) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();
    
        let streaming : AsyncGenerator<GenerateContentResponse>;
        const responseId : string = crypto.randomUUID();
        try {
            streaming = await ep.models.generateContentStream(generateParams);
        } catch (e) {
            // @ts-expect-error: 18046
            console.error(e.message);
    
            // @ts-expect-error: 18046
            throw new ApiError(e.message, { cause: e });
        }

        // 后台运行
        (async() => {
            try {
                let thinking = false;
                let totalTokenCount = 0;
                let promptTokenCount = 0;
                let candidatesTokenCount = 0;
                let cachedContentTokenCount = 0;
                let lastChunk = null;
    
                // 防超时
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Date.now(),
                    model: this._model,
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            content: "",
                        }
                    }]
                })}\n\n`));
    
                // 流式传输
                for await (const chunk of streaming) {
                    const text = chunk.text;
                    lastChunk = chunk;
    
                    if(chunk.candidates?.[0]?.content?.parts?.[0]?.thought) {
                        if(!thinking) {
                            thinking = true;
                            await writer.write(encoder.encode(`data: ${JSON.stringify({
                                id: responseId,
                                object: "chat.completion.chunk",
                                created: Date.now(),
                                model: this._model,
                                choices: [{
                                    index: 0,
                                    delta: {
                                        role: "assistant",
                                        content: "<thinking>\n",
                                    }
                                }]
                            })}\n\n`));
                        }
    
                        const thought = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
                        if(thought) {
                            await writer.write(encoder.encode(`data: ${JSON.stringify({
                                id: responseId,
                                object: "chat.completion.chunk",
                                created: Date.now(),
                                model: this._model,
                                choices: [{
                                    index: 0,
                                    delta: {
                                        role: "assistant",
                                        content: thought,
                                    }
                                }]
                            })}\n\n`));
                        }
                    } else if (thinking) {
                        thinking = false;
                        await writer.write(encoder.encode(`data: ${JSON.stringify({
                            id: responseId,
                            object: "chat.completion.chunk",
                            created: Date.now(),
                            model: this._model,
                            choices: [{
                                index: 0,
                                delta: {
                                    role: "assistant",
                                    content: "\n</thinking>\n",
                                }
                            }]
                        })}\n\n`));
                    }
                    
                    await writer.write(encoder.encode(`data: ${JSON.stringify({
                        id: responseId,
                        object: "chat.completion.chunk",
                        created: new Date(chunk.createTime || Date.now()).getTime(),
                        model: this._model,
                        choices: [{
                            index: 0,
                            delta: text ? { content: text } : { role: "assistant" },
                            finish_reason: chunk?.candidates?.[0]?.finishReason,
                        }],
                        usage: {
                            prompt_tokens: chunk?.usageMetadata?.promptTokenCount,
                            completion_tokens: chunk?.usageMetadata?.candidatesTokenCount,
                            total_tokens: chunk?.usageMetadata?.totalTokenCount,
                            prompt_tokens_details: {
                                cached_tokens: chunk?.usageMetadata?.cachedContentTokenCount,
                            },
                            completion_tokens_details: {
                                reasoning_tokens: chunk?.usageMetadata?.thoughtsTokenCount,
                            },
                        },
                    })}\n\n`));
    
                    totalTokenCount = chunk?.usageMetadata?.totalTokenCount || totalTokenCount;
                    promptTokenCount = chunk?.usageMetadata?.promptTokenCount || promptTokenCount;
                    candidatesTokenCount = chunk?.usageMetadata?.candidatesTokenCount || candidatesTokenCount;
                    cachedContentTokenCount = chunk?.usageMetadata?.cachedContentTokenCount || cachedContentTokenCount;
                }
                
                // 结束
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Date.now(),
                    model: this._model,
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            content: "",
                        },
                        finish_reason: "stop",
                    }]
                })}\n\n`));
    
                if(totalTokenCount) {
                    console.log(`[output] total ${totalTokenCount} tokens used with model ${this._model} (input ${promptTokenCount}, output ${candidatesTokenCount}).`);
                    if(!candidatesTokenCount || candidatesTokenCount <= 1) {
                        await writer.write(encoder.encode(`data: ${JSON.stringify({
                            id: responseId,
                            object: "chat.completion.chunk",
                            created: Date.now(),
                            model: this._model,
                            choices: [{
                                index: 0,
                                delta: {
                                    role: "assistant",
                                    content: `ERROR: prompt was blocked, reason: ${lastChunk?.promptFeedback?.blockReason || lastChunk?.candidates?.[0]?.finishReason}\n${JSON.stringify(lastChunk)}`,
                                },
                                finish_reason: lastChunk?.promptFeedback?.blockReason || lastChunk?.candidates?.[0]?.finishReason || "error",
                            }]
                        })}\n\n`));
                    }
                }
            } catch (e) {
                // @ts-expect-error: 18046
                console.error(e.message);
    
                // 错误输出
                await writer.write(encoder.encode(`data: ${JSON.stringify({
                    id: responseId,
                    object: "chat.completion.chunk",
                    created: Date.now(),
                    model: this._model,
                    choices: [{
                        index: 0,
                        delta: {
                            role: "assistant",
                            // @ts-expect-error: 18046
                            content: `ERROR: ${e.message}`,
                        },
                        finish_reason: "error",
                    }]
                })}\n\n`));
            }
    
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            await writer.close();
        })();
    
        return readable;
    }
    
    async handleNonStream(ep: GoogleGenAI, generateParams: GenerateContentParameters) {
        try {
            const response = await ep.models.generateContent(generateParams);
    
            let thought = "";
            if(response.candidates?.[0]?.content?.parts?.[0]?.thought) {
                thought = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
                if(thought) {
                    thought = `<thinking>\n${thought}\n</thinking>\n`;
                }
            }
    
            if(response.usageMetadata?.totalTokenCount) {
                console.log(`[output] total ${response.usageMetadata?.totalTokenCount} tokens used with model ${this._model} (input ${response.usageMetadata?.promptTokenCount}, output ${response.usageMetadata?.candidatesTokenCount}).`);
                const candidatesTokenCount = response?.usageMetadata?.candidatesTokenCount;
                if(!candidatesTokenCount || candidatesTokenCount <= 1) {
                    return JSON.stringify({
                        id: response.responseId || crypto.randomUUID(),
                        object: "chat.completion",
                        created: new Date(response.createTime || Date.now()).getTime(),
                        model: this._model,
                        choices: [{
                            index: 0,
                            message: {
                                role: "assistant",
                                content: `ERROR: prompt was blocked, reason: ${response.promptFeedback?.blockReason || response?.candidates?.[0]?.finishReason}\n${JSON.stringify(response)}`,
                            },
                            finish_reason: response?.candidates?.[0]?.finishReason || response.promptFeedback?.blockReason || "stop",
                        }],
                        usage: {
                            prompt_tokens: response?.usageMetadata?.promptTokenCount,
                            completion_tokens: response?.usageMetadata?.candidatesTokenCount,
                            total_tokens: response?.usageMetadata?.totalTokenCount,
                            prompt_tokens_details: {
                                cached_tokens: response?.usageMetadata?.cachedContentTokenCount,
                            },
                            completion_tokens_details: {
                                reasoning_tokens: response?.usageMetadata?.thoughtsTokenCount,
                            },
                        },
                    });
                }
            }
    
            const text = thought + response.text;
            return JSON.stringify({
                id: response.responseId || crypto.randomUUID(),
                object: "chat.completion",
                created: new Date(response.createTime || Date.now()).getTime(),
                model: this._model,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: text,
                    },
                    finish_reason: response?.candidates?.[0]?.finishReason || "stop",
                }],
                usage: {
                    prompt_tokens: response?.usageMetadata?.promptTokenCount,
                    completion_tokens: response?.usageMetadata?.candidatesTokenCount,
                    total_tokens: response?.usageMetadata?.totalTokenCount,
                    prompt_tokens_details: {
                        cached_tokens: response?.usageMetadata?.cachedContentTokenCount,
                    },
                    completion_tokens_details: {
                        reasoning_tokens: response?.usageMetadata?.thoughtsTokenCount,
                    },
                },
            });
        } catch (e) {
            // @ts-expect-error: 18046
            console.error(e.message);
    
            // @ts-expect-error: 18046
            throw new ApiError(e.message, { cause: e });
        }
    }
}

interface GeneratePrompt {
    text?: string;
    mime?: string;
    data?: string;
}

interface FeatureInfo {
    role: Record<string, string>;
    removeRole: boolean;
    systemPrompt: string;
    content: string;
}

interface ModelInfo {
    name: string;
    baseModelId: string;
    version: string;
    displayName?: string;
    description?: string;
    inputTokenLimit?: number;
    outputTokenLimit?: number;
    supportedGenerationMethods?: string[];
    temperature?: number;
    maxTemperature?: number;
    topP?: number;
    topK?: number;
    id?: string;
    input: number;
    output: number;
}

async function fetchModels(token: string, cache: boolean = true) : Promise<ModelInfo[]> {
    if(cache) {
        if(MODELS.length > 0)
            return MODELS;

        MODELS = ((await db.get([ "gemini", "models" ]))?.value || []) as ModelInfo[];
        if(MODELS.length > 0)
            return MODELS;
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${token}&pageSize=1000`);
    if(!response.ok)
        throw new ResponseError(`Invalid Gemini API KEY ${token}, error: ${JSON.stringify(await response.json())}`, { status: 401 });

    const data : { models: ModelInfo[] } = await response.json();
    if(!data.models || data.models.length <= 0)
        return [];

    MODELS = data.models.map(x => {
        return {
            ...x,
            id: x.baseModelId || x.name.replace(/^models\//, ""),
            name: x.displayName || x.name,
            object: "model",
            created: Date.now(),
            owned_by: "google",
            input: x.inputTokenLimit || 4096,
            output: x.outputTokenLimit || 4096,
        };
    }).filter(x => x.supportedGenerationMethods?.includes("generateMessage") || x.supportedGenerationMethods?.includes("generateContent"));

    await db.set([ "gemini", "models" ], MODELS, { expireIn: 7 * 60 * 60 * 24 * 1000 });
    // console.log(MODELS);
    return MODELS;
}

async function listModels(tokens: string[]) : Promise<Response> {
    return new Response(JSON.stringify({
        object: "list",
        // @ts-expect-error: 2339
        data: _.sample(await Promise.all(tokens.map(x => fetchModels(x, false)))),
    }), { status: 200 });
}

interface GenerateOptions {
    frequency_penalty?: number;
    include_reasoning?: boolean;
    max_tokens?: number;
    presence_penalty?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    systemPrompt?: string;
}

async function chatCompletions(request: Request, tokens: string[]) : Promise<Response> {
    const body = await request.json();
    return new GenerateServe(body.model, body.stream, tokens).serve(body);
}

async function handler(request: Request) : Promise<Response> {
    try {
        handleOptions(request);
        const tokens = getAccessTokens(request);

        const url = new URL(request.url);
        const path = url.pathname;

        switch(path) {
            case "/v1/models":
            case "/models":
                return await listModels(tokens);
            case "/v1/chat/completions":
            case "/chat/completions":
                return await chatCompletions(request, tokens);
        }
    } catch (e) {
        if(e instanceof ResponseError) {
            console.info(`Error: ${JSON.stringify(e)}`);
            return e.response;
        }

        // @ts-expect-error: 18046
        console.error(e.message);
        // @ts-expect-error: 18046
        return new Response(e.cause?.message || e.message, { status: 500 });
    }

    return new Response("hello world!", { status: 200 });
}

Deno.serve(handler);
