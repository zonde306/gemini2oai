import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerateContentResponse, GenerateContentParameters, ContentListUnion, CountTokensResponse } from "npm:@google/genai";
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

function getTokens(request: Request) : string[] {
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
        throw new ResponseError("No API Key", { status: 400 });
    }

    return api_key;
}

async function getBestToken(tokens: string[], model: string, excluding: Set<string> = new Set<string>()) : Promise<string> {
    tokens = tokens.filter(x => !excluding.has(x));
    if(tokens.length <= 0)
        throw new ResponseError("No avaiable Key", { status: 400 });
    
    const models = await fetchModels(tokens[0]);
    const modelInfo = models.find(x => x.id === model || x.name === model || x.displayName === model);
    if(modelInfo == null) {
        throw new ResponseError(`Invalid model ${model}`, { status: 400 });
    }

    function hash(s: string) {
        return s.split("").reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
    }

    const now = Date.now();
    let usages : number[][] = [];

    // db.getMany 上限为 10，超过则需要分批查询
    for(let i = 0; i < tokens.length / 10; i++) {
        usages = usages.concat(
            (await db.getMany(tokens.slice(10 * i, 10 * (i + 1)).map(x => [ "gemini", "rpm", model, hash(x) ])))
                .map(x => x.value as number[] || [])
                .map(x => x.filter(t => t > now))
        );
    }
    
    const usageIndexes = usages.map(x => x.length);
    // @ts-expect-error: 2339
    const index = usageIndexes.indexOf(_.min(usageIndexes));
    usages[index].push(now + 60 * 1000);
    await db.set([ "gemini", "rpm", model, hash(tokens[index]) ], usages[index], { expireIn: 60 * 1000 });
    return tokens[index];
}

interface GeneratePrompt {
    text?: string;
    mime?: string;
    data?: string;
}

async function uploadFile(urlOrData: string, _ep : GoogleGenAI) : Promise<{ data: string, mime: string }> {
    if(urlOrData.startsWith("http") || urlOrData.startsWith("ftp")) {
        // URL
        const response = await fetch(urlOrData);
        const data = await response.arrayBuffer();
        const mime = response.headers.get("Content-Type") || "application/octet-stream";
        if(data.byteLength > MAX_FILE_SIZE) {
            // TODO: 使用 _ep.files.upload 上传大文件
            throw new ResponseError("File too large", { status: 413 });
        }

        return {
            data: Buffer.from(data).toString("base64"),
            mime: mime,
        };
    } else {
        // data:image/jpeg;base64,...
        const [ mime, data ] = urlOrData.split(";base64,", 1);
        const bolb = Buffer.from(data, "base64");
        if(bolb.byteLength > MAX_FILE_SIZE) {
            // TODO: 使用 _ep.files.upload 上传大文件
            throw new ResponseError("File too large", { status: 413 });
        }
        
        return {
            data: data,
            mime: mime.replace(/^data:/, ""),
        };
    }
}

interface FeatureInfo {
    role: Record<string, string>;
    removeRole: boolean;
    systemPrompt: string;
    content: string;
}

function processMessageContent(content: string, defaults?: FeatureInfo) : FeatureInfo {
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

async function formattingMessages(messages: { role: string, content: unknown }[], ep : GoogleGenAI) : Promise<{ prompts: ContentListUnion, systemPrompt: string }> {
    const results : GeneratePrompt[] = [];
    let feat = processMessageContent("");
    for(const msg of messages) {
        if(Array.isArray(msg.content)) {
            for(const inner of msg.content) {
                if(inner.image_url) {
                    const { data, mime } = await uploadFile(inner.image_url.url, ep);
                    results.push({ mime: mime, data: data });
                } else if(typeof inner === "string") {
                    feat = processMessageContent(inner, feat);
                    results.push({ text: feat.removeRole ? feat.content : `${feat.role[msg.role]}: ${feat.content}` });
                } else {
                    console.error("unknown content type", inner);
                    throw new ResponseError("Unknown content type", { status: 422 });
                }
            }
        } else if (typeof msg.content === "string") {
            feat = processMessageContent(msg.content, feat);
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
        return [];

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
    console.log(MODELS);
    return MODELS;
}

async function listModels(tokens: string[]) : Promise<Response> {
    return new Response(JSON.stringify({
        object: "list",
        data: await fetchModels(tokens[0]),
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

async function prepareGenerateParams(model: string, prompts: ContentListUnion, options: GenerateOptions = {}) : Promise<GenerateContentParameters> {
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
                    threshold: model.includes("gemini-2.0-flash-exp") ? HarmBlockThreshold.OFF : HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: model.includes("gemini-2.0-flash-exp") ? HarmBlockThreshold.OFF : HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: model.includes("gemini-2.0-flash-exp") ? HarmBlockThreshold.OFF : HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: model.includes("gemini-2.0-flash-exp") ? HarmBlockThreshold.OFF : HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
                    threshold: model.includes("gemini-2.0-flash-exp") ? HarmBlockThreshold.OFF : HarmBlockThreshold.BLOCK_NONE,
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

async function handleStream(ep : GoogleGenAI, model: string, generateParams: GenerateContentParameters) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let streaming : AsyncGenerator<GenerateContentResponse>;
    const responseId : string = crypto.randomUUID();
    try {
        streaming = await ep.models.generateContentStream(generateParams);
    } catch (e) {
        console.error(e);

        // @ts-expect-error: 18046
        throw new ApiError(e.message, { cause: e });
    }

    // 后台运行
    (async function() {
        
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
                model: model,
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
                            model: model,
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
                            model: model,
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
                        model: model,
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
                    model: model,
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
                model: model,
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
                console.log(`[output] total ${totalTokenCount} tokens used with model ${model} (input ${promptTokenCount}, output ${candidatesTokenCount}).`);
                if(!candidatesTokenCount || candidatesTokenCount <= 1) {
                    await writer.write(encoder.encode(`data: ${JSON.stringify({
                        id: responseId,
                        object: "chat.completion.chunk",
                        created: Date.now(),
                        model: model,
                        choices: [{
                            index: 0,
                            delta: {
                                role: "assistant",
                                content: `ERROR: output prompt was blocked, reason: ${lastChunk?.promptFeedback?.blockReason}\n${JSON.stringify(lastChunk)}`,
                            },
                            finish_reason: lastChunk?.candidates?.[0]?.finishReason || "error",
                        }]
                    })}\n\n`));
                }
            }
        } catch (e) {
            console.error(e);

            // 错误输出
            await writer.write(encoder.encode(`data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model: model,
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

async function handleNonStream(ep : GoogleGenAI, model: string, generateParams: GenerateContentParameters) {
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
            console.log(`[output] total ${response.usageMetadata?.totalTokenCount} tokens used with model ${model} (input ${response.usageMetadata?.promptTokenCount}, output ${response.usageMetadata?.candidatesTokenCount}).`);
            const candidatesTokenCount = response?.usageMetadata?.candidatesTokenCount;
            if(!candidatesTokenCount || candidatesTokenCount <= 1) {
                return JSON.stringify({
                    id: response.responseId || crypto.randomUUID(),
                    object: "chat.completion",
                    created: new Date(response.createTime || Date.now()).getTime(),
                    model: model,
                    choices: [{
                        index: 0,
                        message: {
                            role: "assistant",
                            content: `ERROR: output prompt was blocked, reason: ${response.promptFeedback?.blockReason}\n${JSON.stringify(response)}`,
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
            }
        }

        const text = thought + response.text;
        return JSON.stringify({
            id: response.responseId || crypto.randomUUID(),
            object: "chat.completion",
            created: new Date(response.createTime || Date.now()).getTime(),
            model: model,
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
        console.error(e);

        // @ts-expect-error: 18046
        throw new ApiError(e.message, { cause: e });
    }
}

async function handleFakeStream(ep : GoogleGenAI, model: string, generateParams: GenerateContentParameters) {
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
            model: model,
            choices: [{
                index: 0,
                delta: {
                    role: "assistant",
                    content: "",
                }
            }]
        })}\n\n`));
    }, 1000);

    (async() => {
        try {
            const response = JSON.parse(await handleNonStream(ep, model, generateParams));
            writer.write(encoder.encode(`data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model: model,
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
        } catch(e) {
            writer.write(encoder.encode(`data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created: Date.now(),
                model: model,
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
            throw e;
        } finally {
            clearInterval(keepAlive);
            await writer.write(encoder.encode("data: [DONE]\n\n"));
            await writer.close();
        }
    })();

    return readable;
}

async function chatCompletions(request: Request, tokens: string[]) : Promise<Response> {
    const headers = new Headers({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
    });

    const body = await request.json();
    const excluding = new Set<string>();
    let result = null;

    for(let i = 0; i < tokens.length; i++) {
        const token = await getBestToken(tokens, body.model, excluding);
        const endpoint = new GoogleGenAI({ apiKey: token });
        const { prompts, systemPrompt } = await formattingMessages(body.messages, endpoint);
        const generateParams = await prepareGenerateParams(body.model, prompts, { ...body, systemPrompt });
        let counter : CountTokensResponse;

        try {
            counter = await endpoint.models.countTokens(generateParams);
        } catch(e) {
            // @ts-expect-error: 18046
            return new Response(`Invalid API Key for #${token.indexOf(token)}: ${e.message}`, { status: 400 });
        }

        console.log(`[input] total ${counter.totalTokens} tokens used with model ${body.model} on ${i + 1} times.`);
        const modelInfo = (await fetchModels(token)).find(x => x.id === body.model || x.name === body.model || x.displayName === body.model);
        if(!modelInfo || (counter.totalTokens && modelInfo.input && counter.totalTokens > modelInfo.input)) {
            return new Response(`too may tokens for model ${body.model} (max: ${modelInfo?.input})`, { status: 400 });
        }

        try {
            if(body.stream && body.fake_stream)
                result = await handleFakeStream(endpoint, body.model, generateParams);
            else if(body.stream)
                result = await handleStream(endpoint, body.model, generateParams);
            else
                result = await handleNonStream(endpoint, body.model, generateParams);
            break;
        } catch(e) {
            if (e instanceof ApiError) {
                // 重试
                excluding.add(token);
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

async function handler(request: Request) : Promise<Response> {
    try {
        handleOptions(request);
        const tokens = getTokens(request);

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

        console.error(e);
        // @ts-expect-error: 18046
        return new Response(e.cause?.message || e.message, { status: 500 });
    }

    return new Response("hello world!", { status: 200 });
}

Deno.serve(handler);
