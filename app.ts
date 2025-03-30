import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerateContentResponse, GenerateContentParameters, ContentListUnion } from "npm:@google/genai";
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
    const models = await fetchModels(tokens[0]);
    const modelInfo = models.find(x => x.id === model || x.name === model || x.displayName === model);
    if(modelInfo == null) {
        throw new ResponseError(`Invalid model ${model}`, { status: 400 });
    }

    function hash(s: string) {
        return s.split("").reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
    }

    const hashedId = hash(tokens.join(","));
    tokens = tokens.filter(x => !excluding.has(x));
    if(tokens.length <= 0)
        throw new ResponseError("No avaiable Key", { status: 400 });

    const poll = ((await db.get([ "gemini", "poll", model, hashedId ]))?.value ?? 0) as number;
    await db.set([ "gemini", "poll", model, hashedId ], poll + 1, { expireIn: 60 * 60 * 24 * 1000 });
    return tokens[poll % tokens.length];
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

async function formattingMessages(messages: { role: string, content: unknown }[], ep : GoogleGenAI) : Promise<ContentListUnion> {
    const results : GeneratePrompt[] = [];
    for(const msg of messages) {
        if(Array.isArray(msg.content)) {
            for(const inner of msg.content) {
                if(inner.image_url) {
                    const { data, mime } = await uploadFile(inner.image_url.url, ep);
                    results.push({ mime: mime, data: data });
                } else if(typeof inner === "string") {
                    results.push({ text: msg.role ? `${msg.role}: ${inner}` : inner });
                } else {
                    console.error("unknown content type", inner);
                    throw new ResponseError("Unknown content type", { status: 422 });
                }
            }
        } else if (typeof msg.content === "string") {
            results.push({ text: msg.role ? `${msg.role}: ${msg.content}` : msg.content });
        } else {
            console.error("unknown content type", msg.content);
            throw new ResponseError("Unknown content type", { status: 422 });
        }
    }

    // @ts-expect-error: 2339
    return results.map(x => _.merge(
        {},
        x.text ? { text: x.text } : {},
        x.mime && x.data ? { inlineData: { mimeType: x.mime, data: x.data } } : {}
    ));
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
        data: await fetchModels(tokens[0], false),
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
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
                {
                    category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
                    threshold: HarmBlockThreshold.BLOCK_NONE,
                },
            ],
            temperature: options.temperature,
            topP: options.top_p,
            maxOutputTokens: Math.min(options.max_tokens || modelConfig.output, modelConfig.output),
            topK: options.top_k,
            frequencyPenalty: options.frequency_penalty,
            presencePenalty: options.presence_penalty,

            // 只有部分模型支持的参数
            ...(options.include_reasoning ? { includeThoughts: true } : {}),
        }
    };
}

async function handleStream(ep : GoogleGenAI, model: string, generateParams: GenerateContentParameters) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let response : AsyncGenerator<GenerateContentResponse>;
    let responseId : string = crypto.randomUUID();
    try {
        response = await ep.models.generateContentStream(generateParams);
    } catch (e) {
        console.error(e);

        // @ts-expect-error: 18046
        throw new ApiError(e.message, { cause: e });
    }

    // 后台运行
    (async function() {
        // console.debug("stream start");
        
        try {
            let thinking = false;
            let totalTokenCount = 0;
            let promptTokenCount = 0;
            let candidatesTokenCount = 0;
            let cachedContentTokenCount = 0;
            let lastChunk = null;

            // 流式传输
            for await (const chunk of response) {
                const text = chunk.text;
                responseId = chunk.responseId || responseId;
                // console.debug(`stream ${responseId} chunk: ${text}`);
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
                    console.info(lastChunk);
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
        // console.debug("stream done");
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
                console.info(response);
            }
        }

        const text = thought + response.text;
        // console.debug(`non stream ${response.responseId} content: ${text}`);
        return JSON.stringify({
            id: response.responseId || crypto.randomUUID(),
            object: "chat.completion",
            created: new Date(response.createTime || Date.now()).getTime(),
            model: model,
            choices: [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": text,
                },
                "finish_reason": response?.candidates?.[0]?.finishReason || "stop",
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
        const prompts = await formattingMessages(body.messages, endpoint);
        const generateParams = await prepareGenerateParams(body.model, prompts, body);
        const counter = await endpoint.models.countTokens(generateParams);
        console.log(`[input] total ${counter.totalTokens} tokens used with model ${body.model} on ${i + 1} times.`);
        const modelInfo = (await fetchModels(token)).find(x => x.id === body.model || x.name === body.model || x.displayName === body.model);
        if(!modelInfo || (counter.totalTokens && modelInfo.input && counter.totalTokens > modelInfo.input)) {
            return new Response(`too may tokens for model ${body.model} (max: ${modelInfo?.input})`, { status: 400 });
        }

        try {
            if(body.stream)
                result = await handleStream(endpoint, body.model, generateParams);
            else
                result = await handleNonStream(endpoint, body.model, generateParams);
        } catch(e) {
            if (e instanceof ApiError) {
                // 重试
                excluding.add(token);
                result = e;
                continue;
            }

            // @ts-expect-error: 18046
            return new Response(e.message, { status: 400 });
        }
    }

    if(result instanceof Error)
        return new Response(result.message, { status: 500 });
    
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
        return new Response(e.message, { status: 500 });
    }

    return new Response("hello world!", { status: 200 });
}

Deno.serve(handler);
