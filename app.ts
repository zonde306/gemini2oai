import { GoogleGenAI, HarmCategory, HarmBlockThreshold, GenerateContentResponse, GenerateContentParameters } from "npm:@google/genai";
import { Buffer } from "node:buffer";
import _ from "npm:lodash";

const AVAIABLE_MODELS = {
    "gemini-2.5-pro-exp-03-25": {
        id: "gemini-2.5-pro-exp-03-25",
        object: "model",
        name: "Gemini 2.5 Pro 实验版",
        created: Date.now(),
        owned_by: "google",
        input: 1048576,
        output: 65536,
        rpm: 2,
        day: 50,
    },
    "gemini-2.0-flash": {
        id: "gemini-2.0-flash",
        object: "model",
        name: "Gemini 2.0 Flash",
        created: Date.now(),
        owned_by: "google",
        input: 1048576,
        output: 8192,
        rpm: 15,
        day: 1500,
    },
    "gemini-2.0-flash-thinking-exp-1219": {
        id: "gemini-2.0-flash-thinking-exp-1219",
        object: "model",
        name: "	Gemini 2.0 Flash Thinking",
        created: Date.now(),
        owned_by: "google",
        input: 1048576,
        output: 8192,
        rpm: 15,
        day: 1500,
    },
    "gemini-2.0-flash-lite": {
        id: "gemini-2.0-flash-lite",
        object: "model",
        name: "Gemini 2.0 Flash-Lite",
        created: Date.now(),
        owned_by: "google",
        input: 1048576,
        output: 8192,
        rpm: 30,
        day: 1500,
    },
    "gemini-1.5-flash": {
        id: "gemini-1.5-flash",
        object: "model",
        name: "Gemini 1.5 Flash",
        created: Date.now(),
        owned_by: "google",
        input: 1048576,
        output: 8192,
        rpm: 15,
        day: 1500,
    },
    "gemini-1.5-flash-8b": {
        id: "gemini-1.5-flash-8b",
        object: "model",
        name: "Gemini 1.5 Flash-8B",
        created: Date.now(),
        owned_by: "google",
        input: 1048576,
        output: 8192,
        rpm: 15,
        day: 1500,
    },
    "gemini-1.5-pro": {
        id: "gemini-1.5-pro",
        object: "model",
        name: "Gemini 1.5 Pro",
        created: Date.now(),
        owned_by: "google",
        input: 2097152,
        output: 8192,
        rpm: 2,
        day: 50,
    },
    /*
    "gemini-embedding-exp": {
        id: "gemini-embedding-exp",
        object: "model",
        name: "Gemini 嵌入",
        created: Date.now(),
        owned_by: "google",
        input: 8192,
    },
    "imagen-3.0-generate-002": {
        id: "imagen-3.0-generate-002",
        object: "model",
        name: "Imagen 3",
        created: Date.now(),
        owned_by: "google",
    },
    */
};

const MAX_FILE_SIZE = 20 * 1000 * 1000; // 20MB, not Mib
const API_KEY = Deno.env.get("API_KEY") || "";
const TOKENS = (Deno.env.get("TOKENS") || "").split(",").map(x => x.trim()).filter(x => x.length > 0);
const db = await Deno.openKv();

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

function hash(s: string) {
    return s.split("").reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0);
}

async function getBestToken(tokens: string[], model: string, excluding: Set<string> = new Set<string>()) : Promise<string> {
    // @ts-expect-error: 7053
    const modelInfo = AVAIABLE_MODELS[model];
    if(modelInfo == null) {
        throw new ResponseError(`Invalid model ${model}`, { status: 400 });
    }

    const now = Date.now() / 1000;

    // RPM 和每日限额
    for(const key of tokens) {
        const hashedId = hash(key);
        if(excluding.has(String(hashedId)) || excluding.has(key))
            continue;

        // 每分钟限额
        let rpm = ((await db.get([ "gemini", "rpm", model, hashedId ]))?.value || []) as number[];
        rpm = rpm.filter(x => x > now);

        // 每日限额
        let rpd = ((await db.get([ "gemini", "rpd", model, hashedId ]))?.value || []) as number[];
        rpd = rpd.filter(x => x > now);

        if(rpm.length >= modelInfo.rpm || rpd.length >= modelInfo.day) {
            continue;
        }

        rpm.push(now + 60);
        rpd.push(now + 60 * 60 * 24);
        await db.set([ "gemini", "rpm", model, hashedId ], rpm, { expireIn: 60 * 1000 });
        await db.set([ "gemini", "rpd", model, hashedId ], rpd, { expireIn: 60 * 60 * 24 * 1000 });
        return key;
    }

    throw new ResponseError("No avaiable Key", { status: 400 });
}

interface GeneratePrompt {
    text?: string;
    mime?: string;
    data?: string;
}

async function uploadFile(urlOrData: string, _toekn: string) : Promise<{ data: string, mime: string }> {
    if(urlOrData.startsWith("http") || urlOrData.startsWith("ftp")) {
        // URL
        const response = await fetch(urlOrData);
        const data = await response.arrayBuffer();
        const mime = response.headers.get("Content-Type") || "application/octet-stream";
        if(data.byteLength > MAX_FILE_SIZE) {
            // TODO: 使用 GoogleGenAI.files.upload 上传大文件
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
            // TODO: 使用 GoogleGenAI.files.upload 上传大文件
            throw new ResponseError("File too large", { status: 413 });
        }
        
        return {
            data: data,
            mime: mime.replace(/^data:/, ""),
        };
    }
}

async function formattingMessages(messages: { role: string, content: unknown }[], toekn: string) : Promise<GeneratePrompt[]> {
    const results : GeneratePrompt[] = [];
    for(const msg of messages) {
        if(Array.isArray(msg.content)) {
            for(const inner of msg.content) {
                if(inner.image_url) {
                    const { data, mime } = await uploadFile(inner.image_url.url, toekn);
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

    return results;
}

function models() : Response {
    return new Response(JSON.stringify({
        object: "list",
        data: Object.values(AVAIABLE_MODELS),
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

function prepareGenerateParams(model: string, prompts: GeneratePrompt[], options: GenerateOptions = {}) : GenerateContentParameters {
    // @ts-expect-error: 7053
    const modelConfig = AVAIABLE_MODELS[model];

    return {
        model: model,
        // @ts-expect-error: 2339
        contents: prompts.map(x => _.merge({}, x.text ? { text: x.text } : {}, x.mime && x.data ? { inlineData: { mimeType: x.mime, data: x.data } } : {})),
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

async function handleStream(key: string, model: string, generateParams: GenerateContentParameters) {
    const ep = new GoogleGenAI({ apiKey: key });
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    let response : AsyncGenerator<GenerateContentResponse>;
    let responseId : string = crypto.randomUUID();
    try {
        response = await ep.models.generateContentStream(generateParams);
    } catch (e) {
        // @ts-expect-error: 18046
        console.error(e.message);
        console.error(e);

        // @ts-expect-error: 18046
        throw new ApiError(e.message, { cause: e });
    }

    // 后台运行
    (async function() {
        // console.debug("stream start");
        
        try {
            let thinking = false;

            // 流式传输
            for await (const chunk of response) {
                const text = chunk.text;
                responseId = chunk.responseId || responseId;
                // console.debug(`stream ${responseId} chunk: ${text}`);

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
                    }],
                })}\n\n`));
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

async function handleNonStream(key: string, model: string, generateParams: GenerateContentParameters) {
    const ep = new GoogleGenAI({ apiKey: key });

    try {
        const response = await ep.models.generateContent(generateParams);

        let thought = "";
        if(response.candidates?.[0]?.content?.parts?.[0]?.thought) {
            thought = response.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if(thought) {
                thought = `<thinking>\n${thought}\n</thinking>\n`;
            }
        }

        const text = thought + response.text;
        // console.debug(`non stream ${response.responseId} content: ${text}`);
        return JSON.stringify({
            id: response.responseId || crypto.randomUUID(),
            object: "chat.completion",
            created: new Date(response.createTime || Date.now()).getTime(),
            model: model,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": text,
                },
                "finish_reason": "stop",
            }]
        });
    } catch (e) {
        // @ts-expect-error: 18046
        console.error(e.message);
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
    let key = "";

    for(let i = 0; i < tokens.length; i++) {
        try {
            key = await getBestToken(tokens, body.model, excluding);
            const prompts = await formattingMessages(body.messages, key);
            const generateParams = prepareGenerateParams(body.model, prompts, body);

            if(body.stream)
                result = await handleStream(key, body.model, generateParams);
            else
                result = await handleNonStream(key, body.model, generateParams);
        } catch(e) {
            if (e instanceof ApiError) {
                // 重试
                excluding.add(key);
                continue;
            }

            throw e;
        }
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
                return models();
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
