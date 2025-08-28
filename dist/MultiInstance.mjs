// src/logging.ts
import { Log } from "debug-level";
Log.options({ json: true, colors: true });
Log.wrapConsole("bot-ws", { level4log: "INFO" });
var botLog = new Log("bot");
var openAILog = new Log("open-ai");
var matterMostLog = new Log("mattermost");

// src/plugins/PluginBase.ts
var PluginBase = class {
  constructor(key, description) {
    this.key = key;
    this.description = description;
  }
  log = botLog;
  pluginArguments = {};
  requiredArguments = [];
  setup(_plugins) {
    return true;
  }
  isEnable(plugins, pluginName) {
    if (!plugins || plugins.indexOf(pluginName) === -1) return false;
    return true;
  }
  addPluginArgument(name, type, description, optional = false) {
    this.pluginArguments[name] = { type, description };
    if (!optional) {
      this.requiredArguments.push(name);
    }
  }
};

// src/plugins/ExitPlugin.ts
var ExitPlugin = class extends PluginBase {
  async runPlugin(_args, _msgData, openAIWrapper) {
    return {
      message: "Goodbye! :wave:\n```" + openAIWrapper.getAIProvidersName() + " left the conversation.```",
      props: { bot_status: "stopped" }
    };
  }
};

// src/BotService.ts
import FormData3 from "form-data";

// src/plugins/GraphPlugin.ts
import FormData2 from "form-data";
import fetch2 from "node-fetch";
var GraphPlugin = class extends PluginBase {
  yFilesGPTServerUrl = process.env["YFILES_SERVER_URL"];
  yFilesEndpoint = this.yFilesGPTServerUrl ? new URL("/json-to-svg", this.yFilesGPTServerUrl) : void 0;
  VISUALIZE_DIAGRAM_INSTRUCTIONS = "You are a helpfull assistant who creates a diagram based on the input the user provides you.You only respond with a valid JSON object text in a <GRAPH> tag. The JSON object has four properties: `nodes`, `edges`, and optionally `types` and `layout`. Each `nodes` object has an `id`, `label`, and an optional `type` property. Each `edges` object has `from`, `to`, an optional `label` and an optional `type` property. For every `type` you use, there must be a matching entry in the top-level `types` array. Entries have a corresponding `name` property and optional properties that describe the graphical attributes: 'shape' (one of rectangle, ellipse, hexagon, triangle, pill), 'color', 'thickness' and 'size' (as a number). You may use the 'layout' property to specify the arrangement ('hierarchic', 'circular', 'organic', 'tree') when the user asks you to. Do not include these instructions in the output. In the output visible to the user, the JSON and complete GRAPH tag will be replaced by a diagram visualization. So do not explain or mention the JSON. Instead, pretend that the user can see the diagram. Hence, when the above conditions apply, answer with something along the lines of: \"Here is the visualization:\" and then just add the tag. The user will see the rendered image, but not the JSON. Shortly explain what the diagram is about, but do not state how you constructed the JSON.";
  setup(plugins) {
    this.addPluginArgument(
      "graphPrompt",
      "string",
      "A description or topic of the graph. This may also includes style, layout or edge properties"
    );
    if (!this.isEnable(plugins, "graph-plugin") || !this.yFilesGPTServerUrl) return false;
    return true;
  }
  /* Plugin entry point */
  async runPlugin(args, msgData, openAIWrapper) {
    const aiResponse = {
      message: "Sorry, I could not execute the graph plugin."
    };
    const chatmessages = [
      {
        role: "system",
        //ChatCompletionRequestMessageRoleEnum.System,
        content: this.VISUALIZE_DIAGRAM_INSTRUCTIONS
      },
      {
        role: "user",
        //hatCompletionRequestMessageRoleEnum.User,
        content: args.graphPrompt
      }
    ];
    const response = await openAIWrapper.createChatCompletion(chatmessages, void 0);
    if (response?.responseMessage?.content) {
      return await this.processGraphResponse(
        response.responseMessage.content,
        msgData.post.channel_id,
        openAIWrapper.getMattermostClient().getClient()
      );
    }
    return aiResponse;
  }
  async processGraphResponse(content, channelId, mattermostClient) {
    const result = {
      message: content
    };
    const replaceStart = content.match(/<graph>/i)?.index;
    let replaceEnd = content.match(/<\/graph>/i)?.index;
    if (replaceEnd) {
      replaceEnd += "</graph>".length;
    }
    if (replaceStart && replaceEnd) {
      const graphContent = content.substring(replaceStart, replaceEnd).replace(/<\/?graph>/gi, "").trim();
      try {
        const sanitized = JSON.parse(graphContent);
        const fileId = await this.jsonToFileId(JSON.stringify(sanitized), channelId, mattermostClient);
        const pre = content.substring(0, replaceStart);
        const post = content.substring(replaceEnd);
        if (post.trim().length < 1) {
          result.message = pre;
        } else {
          result.message = `${pre} [see attached image] ${post}`;
        }
        result.props = { originalMessage: content };
        result.fileId = [fileId];
      } catch (e) {
        this.log.error(e);
        this.log.error(`The input was:

${graphContent}`);
      }
    }
    return result;
  }
  async generateSvg(jsonString) {
    return fetch2(this.yFilesEndpoint, {
      method: "POST",
      body: jsonString,
      headers: {
        "Content-Type": "application/json"
      }
    }).then((response) => {
      if (!response.ok) {
        throw new Error("Bad response from server");
      }
      return response.text();
    });
  }
  async jsonToFileId(jsonString, channelId, mattermostClient) {
    const svgString = await this.generateSvg(jsonString);
    const form = new FormData2();
    form.append("channel_id", channelId);
    form.append("files", Buffer.from(svgString), "diagram.svg");
    this.log.trace("Appending Diagram SVG", svgString);
    const response = await mattermostClient.uploadFile(form);
    this.log.trace("Uploaded a file with id", response?.file_infos[0].id);
    return response?.file_infos[0].id;
  }
};

// src/AIProvider.ts
import { Log as Log2 } from "debug-level";
Log2.options({ json: true, colors: true });
var log = new Log2("AIAdapter");
var AIAdapter = class {
  // OpenAIのUserロールからメッセージを取り出す
  getLastMessage(messages) {
    return messages.pop();
  }
  getUserMessage(openAImessage) {
    if (!openAImessage) {
      return "";
    }
    let message = "";
    if (openAImessage.content) {
      if (typeof openAImessage.content === "string") {
        message = openAImessage.content;
      } else {
        openAImessage.content.forEach((content) => {
          if (content.type === "text") {
            const contentPartText = content;
            message += contentPartText.text;
          } else if (content.type === "image_url") {
            const contentPartImage = content;
            log.debug("Not support man image_url", contentPartImage.type, shortenString(contentPartImage.image_url.url));
          } else if (content.type === "file") {
            const contentPartFile = content;
            log.debug(
              "Not support file",
              contentPartFile.type,
              contentPartFile.file.filename,
              shortenString(contentPartFile.file.file_data)
            );
          } else if (content.type === "input_audio") {
            const contentPartAudio = content;
            log.debug(
              "Not support input_audio",
              contentPartAudio.type,
              shortenString(contentPartAudio.input_audio.data)
            );
          } else {
            log.warn("Unknown content type:", content.type, content);
          }
        });
      }
    }
    log.trace("getUserMessage():", message);
    return message;
  }
  // OpenAIのFunctionsをToolsに書き換える
  convertFunctionsToTools(functions, tools) {
    if (functions && functions.length > 0) {
      if (!tools) {
        tools = [];
      }
      functions.forEach((functionCall) => {
        tools?.push({
          type: "function",
          function: {
            name: functionCall.name,
            description: functionCall.description,
            parameters: functionCall.parameters
          }
        });
      });
    }
    return tools;
  }
};
function shortenString(text) {
  if (!text) {
    return text;
  }
  if (text.length < 1024) {
    return text;
  }
  return text.substring(0, 1023) + "...";
}

// src/adapters/AnthropicAdapter.ts
import Anthropic from "@anthropic-ai/sdk";
var AnthropicAdapter = class {
  anthropic;
  baseURL;
  constructor(args) {
    this.anthropic = new Anthropic(args);
    this.baseURL = this.anthropic.baseURL;
  }
  async createMessage(options) {
    const completion = await this.anthropic.messages.create(
      options
    );
    const response = this.mapAnthropicMessageToOpenAICompletion(completion);
    return { response, images: [] };
  }
  mapAnthropicMessageToOpenAICompletion(completion) {
    const choices = [
      { message: completion }
    ];
    const usage = {
      //トータルトークン無いし属性名も違うの詰め替える
      prompt_tokens: completion.usage.input_tokens,
      completion_tokens: completion.usage.output_tokens,
      total_tokens: completion.usage.input_tokens + completion.usage.output_tokens
    };
    return {
      choices,
      usage,
      model: completion.model,
      id: completion.id,
      role: completion.role
    };
  }
  async imagesGenerate(_imageGeneratePrams) {
    throw new Error("Anthropic does not support image generation.");
  }
};

// src/adapters/CohereAdapter.ts
import { CohereClient } from "cohere-ai";
import Log3 from "debug-level";
Log3.options({ json: true, colors: true });
var log2 = new Log3("Cohere");
var CohereAdapter = class extends AIAdapter {
  cohere;
  baseURL;
  constructor(args) {
    super();
    this.cohere = new CohereClient({ token: args?.apiKey });
    this.baseURL = "https://api.cohere.ai/";
  }
  async createMessage(options) {
    const chat = await this.cohere.chat(this.createCohereRequest(options));
    log2.debug("Cohere chat() response: ", chat);
    const response = this.createOpenAIChatCompletion(chat, options.model);
    return { response, images: [] };
  }
  createOpenAIChatCompletion(chat, model) {
    const choices = [
      {
        finish_reason: "stop",
        index: 0,
        logprobs: null,
        //ログ確率情報
        message: this.createResponseMessages(chat)
        //tools_callsもここで作る
      }
    ];
    const inputTokens = chat.meta?.billedUnits?.inputTokens ?? -1;
    const outputTokens = chat.meta?.billedUnits?.outputTokens ?? -1;
    return {
      id: "",
      created: 0,
      object: "chat.completion",
      //OputAI固定値
      choices,
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens
      },
      model
    };
  }
  createResponseMessages(chat) {
    if (chat.toolCalls && chat.toolCalls.length > 0) {
      return this.createToolCallMessage(chat.toolCalls);
    } else {
      return {
        role: "assistant",
        content: chat.text,
        refusal: null
        // アシスタントからの拒否メッセージ
      };
    }
  }
  createToolCallMessage(toolCalls) {
    const openAItoolCalls = toolCalls.map((toolCall) => ({
      // Cohre形式をOpenAI形式に変換
      id: "",
      //TODO: toolCall.generation_idを追加予定
      type: "function",
      function: {
        name: this.decodeName(toolCall.name),
        arguments: JSON.stringify(toolCall.parameters)
      }
    }));
    const message = {
      role: "assistant",
      content: null,
      tool_calls: openAItoolCalls,
      refusal: null
      // アシスタントからの拒否メッセージ
    };
    return message;
  }
  createCohereRequest(options) {
    let tools = this.createCohereTools(options.tools, options.functions);
    tools = void 0;
    const chatRequest = {
      model: options.model,
      message: this.getUserMessage(this.getLastMessage(options.messages)),
      //最後のメッセージがユーザのメッセージ
      temperature: options.temperature ?? void 0,
      maxTokens: options.max_tokens ?? void 0,
      p: options.top_p ?? void 0,
      tools,
      chatHistory: this.getChatHistory(options.messages)
      //TODO: getUserMessage()されてから呼ばれている?
    };
    log2.trace("mapOpenAIOptionsToCohereOptions(): chatRequest", chatRequest);
    return chatRequest;
  }
  createCohereTools(tools, functions) {
    tools = this.convertFunctionsToTools(functions, tools);
    if (!tools || tools.length === 0) {
      return void 0;
    }
    const cohereTools = [];
    tools.forEach((tool) => {
      if (tool.type !== "function") {
        log2.error(`createCohereTools(): ${tool.type} not function.`, tool);
        return;
      }
      let parameterDefinitions;
      if (tool.function.parameters) {
        if (tool.function.parameters.type !== "object") {
          log2.error(`createCohereTools(): parameter.type ${tool.function.parameters.type} is not  'object'`);
          return;
        }
        const props = tool.function.parameters.properties;
        parameterDefinitions = {};
        for (const propsKey in props) {
          const param = props[propsKey];
          parameterDefinitions[propsKey] = {
            description: param.description,
            type: param.type,
            required: param.required
          };
        }
      }
      cohereTools.push({
        description: tool.function.description ?? "",
        name: this.encodeName(tool.function.name),
        //tool names can only contain certain characters (A-Za-z0-9_) and can't begin with a digit
        parameterDefinitions
      });
    });
    return cohereTools;
  }
  /*
   * TypeScriptでCohere.Toolの名前をA-Za-z0-9_以外を__HEXエンコードするプログラム
   */
  encodeName(name) {
    const encodedName = name.replaceAll("-", "_");
    return encodedName;
  }
  decodeName(name) {
    const decodedName = name.replaceAll("_", "-");
    return decodedName;
  }
  getChatHistory(messages) {
    if (messages.length < 1) {
      return void 0;
    }
    const chatHistory = [];
    messages.forEach((message) => {
      if (message.role === "user") {
        chatHistory.push({
          role: "USER",
          message: this.getUserMessage(message)
        });
      } else if (message.role === "system") {
        chatHistory.push({
          role: "SYSTEM",
          message: this.getMessage(message.content)
        });
      } else if (message.role === "assistant") {
        chatHistory.push({
          role: "CHATBOT",
          message: this.getMessage(message.content ?? "")
        });
      } else {
        log2.debug(`getChatHistory(): ${message.role} not yet support.`, message);
      }
    });
    return chatHistory;
  }
  getMessage(content) {
    let message = "";
    if (typeof content === "string") {
      message = content;
    } else {
      content.forEach((content2) => {
        if (content2.type === "text") {
          const contentPartText = content2;
          message += contentPartText.text;
        } else if (content2.type === "refusal") {
          const contentPartRefusal = content2;
          message += "refusal: " + contentPartRefusal.refusal;
        } else {
          log2.warn("getMessage(): Unknown content type:", content2);
        }
      });
    }
    return message;
  }
  async imagesGenerate(_imageGeneratePrams) {
    throw new Error("Cohere does not support image generation.");
  }
};

// src/adapters/GoogleGeminiAdapter.ts
import * as lame from "@breezystack/lamejs";
import {
  FinishReason,
  GoogleGenAI,
  Modality,
  Type
} from "@google/genai";
import { Log as Log4 } from "debug-level";
Log4.options({ json: true, colors: true });
var log3 = new Log4("Gemini");
var GoogleGeminiAdapter = class extends AIAdapter {
  generativeModels;
  baseURL;
  MAX_TOKENS;
  temperature;
  model;
  constructor(apiKey, model, MAX_TOKENS, temperature) {
    super();
    this.MAX_TOKENS = MAX_TOKENS;
    this.temperature = temperature;
    this.model = model;
    const ai = new GoogleGenAI({
      apiKey
      // httpOptions: { apiVersion: 'v1beta' }, //v1beta v1alpha
    });
    this.generativeModels = ai.models;
    this.baseURL = `https://generativelanguage.googleapis.com/v1beta/models/${model}:`;
  }
  async createMessage(options) {
    const isImageSupported = [
      // 画像対応のモデル
      "gemini-2.5-flash-image-preview",
      "models/gemini-2.0-flash-preview-image-generation",
      "gemini-2.0-flash-exp-image-generation",
      "gemini-2.0-flash-preview-image-generation",
      //
      "gemini-2.0-flash-exp"
      // The support is not official
    ].some((model) => this.model === model) || this.model.includes("-image");
    const isNotSupportedFunction = [
      // 関数未対応のモデル
      "gemini-2.5-flash-image-preview",
      "gemini-2.5-pro-preview-tts",
      "gemini-2.5-flash-preview-tts",
      "models/gemini-2.0-flash-preview-image-generation",
      "gemini-2.0-flash-exp-image-generation",
      "gemini-2.0-flash-preview-image-generation",
      //
      "models/gemini-2.0-flash-lite",
      "gemini-2.0-flash-lite",
      "gemini-2.0-flash-exp"
    ].some((model) => this.model === model);
    const isSupportedGroundingTool = [
      // Google検索ツールが使えるけど、Functionと同時に使えないモデル
      "gemini-2.5-pro",
      "gemini-2.5-pro-preview",
      "gemini-2.5-pro-preview-06-05",
      "gemini-2.5-pro-preview-05-06",
      "gemini-2.5-flash",
      "gemini-2.5-flash-preview-05-20",
      "gemini-2.5-flash-lite-preview-06-17"
    ].some((model) => this.model === model);
    const isSupportedThinkingBudget = [
      // Thinking Budgetが使えるモデル
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite"
    ].some((model) => this.model.startsWith(model));
    let systemInstruction = isImageSupported ? void 0 : this.createContents([options.messages.shift()])[0];
    let responseModalities = isImageSupported ? [Modality.IMAGE, Modality.TEXT] : [Modality.TEXT];
    if (["gemini-2.5-pro-preview-tts", "gemini-2.5-flash-preview-tts"].some((model) => this.model === model)) {
      systemInstruction = void 0;
      responseModalities = [Modality.AUDIO];
    }
    const currentMessages = this.createContents(options.messages);
    let tools = void 0;
    if (isNotSupportedFunction) {
      tools = void 0;
    } else {
      let tool = this.createGeminiTool(options.tools, options.functions);
      if (isSupportedGroundingTool) {
        tool = { googleSearch: {} };
        tools = [tool];
      }
      if (tool) {
        tools = [tool];
      }
    }
    const request = {
      model: this.model,
      // https://ai.google.dev/api/rest/v1/models/generateContent?hl=ja#request-body
      // https://ai.google.dev/api/rest/v1beta/models/generateContent?hl=ja
      contents: currentMessages,
      //safetySettings,
      //generationConfig,
      config: {
        systemInstruction,
        maxOutputTokens: this.MAX_TOKENS,
        temperature: this.temperature,
        //topP, TopK
        tools,
        // v1betaより
        //toolConfig?: ToolConfig;
        responseModalities
        //なくてもIMAGEできる responseMimeType: 'text/plain',
      }
    };
    if (isSupportedThinkingBudget) {
      request.config.thinkingConfig = {
        includeThoughts: true,
        // 思考を含める
        thinkingBudget: -1
        // 動的思考
      };
    }
    log3.trace("request", JSON.parse(this.shortenLongString(JSON.stringify(request))));
    const generateContentResponse = await this.generativeModels.generateContent(request);
    log3.trace("generateContentResponse", this.shortenResponse(generateContentResponse));
    let usage;
    const { choices, tokenCount: tokenCount2, images } = await this.createChoices(generateContentResponse.candidates);
    if (generateContentResponse.usageMetadata) {
      usage = {
        completion_tokens: generateContentResponse.usageMetadata.candidatesTokenCount || 0,
        prompt_tokens: generateContentResponse.usageMetadata.promptTokenCount || tokenCount2,
        // usageMetadata.promptTokenCountは無い時はtokenCountを使う
        total_tokens: generateContentResponse.usageMetadata.totalTokenCount || 0
        // completion_tokens_details?: CompletionUsage.CompletionTokensDetails || 0,
        // prompt_tokens_details?: CompletionUsage.PromptTokensDetails || 0,
      };
    } else {
      usage = await this.getUsage(currentMessages, tokenCount2);
    }
    return {
      response: {
        id: "",
        choices,
        created: 0,
        model: options.model,
        system_fingerprint: "",
        object: "chat.completion",
        //OpenAI固定値
        usage
      },
      images
    };
  }
  // TRACE Gemini   "modelVersion": "gemini-2.0-flash-preview-image-generation",
  // TRACE Gemini   "usageMetadata": {
  // TRACE Gemini     "promptTokenCount": 62,
  // TRACE Gemini     "candidatesTokenCount": 6,
  // TRACE Gemini     "totalTokenCount": 68,
  // TRACE Gemini     "promptTokensDetails": [
  // TRACE Gemini       {
  // TRACE Gemini         "modality": "TEXT",
  // TRACE Gemini         "tokenCount": 62
  // TRACE Gemini       }
  // TRACE Gemini     ]
  // TRACE Gemini   }
  shortenResponse(generateContentResponse) {
    const g = JSON.parse(JSON.stringify(generateContentResponse));
    g.candidates?.forEach((candidate) => {
      candidate.content?.parts?.forEach((part) => {
        if (part.inlineData) {
          part.inlineData.data = shortenString(part.inlineData.data) || "";
        }
      });
    });
    return JSON.stringify(g);
  }
  shortenLongString(str) {
    const regex = /"((?:\\.|[^"\\])*)"/g;
    return str.replace(regex, function(match, content) {
      if (content.length > 1024) {
        return `"${content.slice(0, 1024)}..."`;
      } else {
        return match;
      }
    });
  }
  async createChoices(candidates) {
    let tokenCount2 = 0;
    const choices = [];
    const images = [];
    if (!candidates) {
      return { choices, tokenCount: tokenCount2, images };
    }
    for (const candidate of candidates) {
      tokenCount2 += candidate.tokenCount ?? 0;
      let content = null;
      let toolCalls = void 0;
      if (candidate.finishReason !== FinishReason.STOP && candidate.finishReason !== FinishReason.MAX_TOKENS && candidate.finishReason !== FinishReason.OTHER) {
        log3.error(`Abnormal finishReason ${candidate.finishReason}`);
        continue;
      }
      for (const part of candidate.content?.parts ?? []) {
        let found = false;
        if (part.functionCall) {
          found = true;
          if (!toolCalls) {
            toolCalls = [];
          }
          toolCalls.push({
            id: "",
            type: "function",
            function: {
              name: part.functionCall.name?.replaceAll("_", "-") || "name" + part.functionCall.id,
              //なぜか、pluginの名前の「-」が「_」になってしまう。
              arguments: JSON.stringify(part.functionCall.args)
            }
          });
        }
        if (part.text) {
          found = true;
          if (!content) {
            content = "";
          }
          content += part.text;
        }
        if (part.inlineData) {
          found = true;
          const imageData = part.inlineData;
          if (imageData) {
            if (imageData.mimeType?.startsWith("image/")) {
              images.push(new Blob([Buffer.from(imageData.data || "", "base64")], { type: imageData.mimeType }));
            } else if (imageData.mimeType?.startsWith("audio/")) {
              const blob = new Blob([Buffer.from(imageData.data || "", "base64")], { type: imageData.mimeType });
              images.push(await this.encodeToMP3(blob));
            }
          }
        }
        if (!found) {
          log3.error(`Unexpected part`, part);
        }
      }
      choices.push({
        index: candidate.index || 0,
        finish_reason: "stop",
        //| 'length' | 'tool_calls' | 'content_filter' | 'function_call';
        logprobs: null,
        //Choice.Logprobs | null;  //ログ確率情報
        message: {
          role: "assistant",
          //this.convertRoleGeminitoOpenAI(candidate.content.role),
          content,
          tool_calls: toolCalls,
          refusal: null
          // アシスタントからの拒否メッセージ
        }
      });
    }
    return { choices, tokenCount: tokenCount2, images };
  }
  /**
   * L16 RAW形式（audio/L16;codec=pcm;rate=24000）の音声データをMP3形式に変換する非同期関数
   * @param l16raw L16 RAW形式の音声データ（Blob）BASE64解除済みのバイナリ
   * @returns 変換後のMP3データ（Blob）バイナリ をPromiseで返す
   */
  async encodeToMP3(l16raw) {
    const rate = this.getRate(l16raw.type);
    const mp3encoder = new lame.Mp3Encoder(1, rate, 128);
    const buffer = Buffer.from(await l16raw.arrayBuffer());
    const int16Array = new Int16Array(buffer.buffer);
    let mp3Tmp = mp3encoder.encodeBuffer(int16Array);
    const mp3data = [];
    if (mp3Tmp.length > 0) {
      mp3data.push(mp3Tmp);
    }
    mp3Tmp = mp3encoder.flush();
    if (mp3Tmp.length > 0) {
      mp3data.push(mp3Tmp);
    }
    return new Blob(mp3data, { type: "audio/mp3" });
  }
  // mime-typeからサンプリングレートを取得
  getRate(mimeType) {
    let rateStr = mimeType.match(/rate=(\d+)/)?.[1];
    if (!rateStr) {
      log3.warn("Unknown sampling rate for L16 RAW, using default 24000 Hz");
      rateStr = "24000";
    }
    const rate = parseInt(rateStr, 10);
    return rate;
  }
  createGeminiTool(tools, functions) {
    tools = this.convertFunctionsToTools(functions, tools);
    if (!tools || tools.length === 0) {
      return void 0;
    }
    const functionDeclarations = [];
    const geminiTool = {
      functionDeclarations
    };
    tools.forEach((tool) => {
      if (tool.type !== "function") {
        log3.error(`Unexpected tool type ${tool.type}`, tool);
        return;
      }
      const properties = {};
      const props = tool.function.parameters?.properties;
      for (const propKey in props) {
        const param = props[propKey];
        properties[propKey] = {
          type: param.type,
          description: param.description
          //format: param.format,
          //nullable: param.nullable,
          //items: param.items,
          //enum: param.enum,
          /** Optional. Map of {@link FunctionDeclarationSchema}. */
          //properties?: { [k: string]: FunctionDeclarationSchema; };
          //required: param.required,
          //example:
        };
      }
      let parameters = tool.function.parameters;
      this.convertType(tool, parameters);
      parameters = this.workaroundObjectNoParameters(parameters);
      functionDeclarations.push({
        name: tool.function.name,
        description: tool.function.description,
        parameters
      });
    });
    return geminiTool;
  }
  workaroundObjectNoParameters(parameters) {
    if (parameters?.type === Type.OBJECT && Object.keys(parameters?.properties ?? []).length === 0) {
      parameters = void 0;
    }
    return parameters;
  }
  convertType(tool, parameters) {
    const typeMapping = {
      object: Type.OBJECT,
      string: Type.STRING,
      number: Type.NUMBER,
      integer: Type.INTEGER,
      boolean: Type.BOOLEAN,
      array: Type.ARRAY
    };
    if (tool.type === "function" && "function" in tool && tool.function?.parameters) {
      const paramType = tool.function.parameters.type;
      if (paramType && typeMapping[paramType]) {
        parameters.type = typeMapping[paramType];
      }
    }
  }
  createContents(messages) {
    const currentMessages = [];
    messages.forEach(async (message) => {
      switch (message.role) {
        // To Google ["user", "model", "function", "system"]
        case "system":
          currentMessages.push({
            role: "user",
            parts: this.createParts(message, message.name ? `${message.name} says: ` : "")
          });
          currentMessages.push({ role: "model", parts: [{ text: " " }] });
          break;
        case "user":
          currentMessages.push({
            role: "user",
            parts: this.createParts(message, message.name ? `${message.name} says: ` : "")
          });
          break;
        case "assistant":
          currentMessages.push({
            role: "model",
            parts: this.createParts(message, message.name ? `${message.name} says: ` : "")
          });
          break;
        case "tool":
        case "function":
        //Deprecated
        default:
          log3.error(`getChatHistory(): ${message.role} not yet support.`, message);
          break;
      }
    });
    return currentMessages;
  }
  mapShotenInlineData(contents) {
    return contents.map((message) => {
      const newMessage = {
        role: message.role,
        parts: this.mapShotenInlineDataInParts(message.parts ?? [])
      };
      return newMessage;
    });
  }
  mapShotenInlineDataInParts(parts) {
    return parts.map((part) => {
      let newPart;
      if (part.text) {
        newPart = { text: part.text };
      } else if (part.inlineData) {
        newPart = {
          inlineData: {
            mimeType: part.inlineData.mimeType,
            data: shortenString(part.inlineData.data) ?? ""
          }
        };
      } else if (part.fileData) {
        newPart = {
          fileData: {
            fileUri: part.fileData.fileUri,
            mimeType: part.fileData.mimeType
          }
        };
      } else {
        log3.error("Unexpected Part type", part);
        newPart = part;
      }
      return newPart;
    });
  }
  createParts(openAImessage, name) {
    const parts = [];
    if (!openAImessage || !openAImessage.content) {
      return parts;
    }
    if (typeof openAImessage.content === "string") {
      parts.push({ text: name + openAImessage.content });
    } else {
      openAImessage.content.forEach((contentPart) => {
        const contentPartText = contentPart;
        if (contentPartText.type === "text") {
          parts.push({ text: name + contentPartText.text });
        } else if (contentPartText.type === "image_url") {
          const conteentPartImage = contentPart;
          const dataURL = conteentPartImage.image_url?.url;
          this.createPart(dataURL, parts);
        } else if (contentPartText.type === "file") {
          const conteentPartFile = contentPart;
          const dataURL = conteentPartFile.file.file_data;
          this.createPart(dataURL, parts);
        } else {
          log3.error(`Ignore unsupported message ${contentPartText.type} type`, contentPartText);
        }
      });
    }
    return parts;
  }
  createPart(dataURL, parts) {
    const notSupportedAudioAndVideo = [
      // TSSはマルチターンchat未対応なので、そもそも無茶
      `gemini-2.5-flash-preview-tts`,
      `gemini-2.5-pro-preview-tts`
    ].some((model) => this.model === model);
    if (dataURL.startsWith("http")) {
      const extensionMimeMap = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".heic": "image/heic",
        ".heif": "image/heif",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".mp4": "video/mp4",
        ".mpeg": "video/mpeg",
        ".mov": "video/mov",
        ".avi": "video/avi",
        ".x-flv": "video/x-flv",
        ".mpg": "video/mpg",
        ".webm": "video/webm",
        ".wmv": "video/wmv",
        ".3gp": "video/3gpp",
        ".3gpp": "video/3gpp",
        ".pdf": "application/pdf",
        ".js": "application/x-javascript",
        ".py": "application/x-python",
        ".txt": "text/plain",
        ".html": "text/html",
        ".css": "text/css",
        ".md": "text/md",
        ".csv": "text/csv",
        ".xml": "text/xml",
        ".rtf": "text/rtf",
        ".json": "application/json",
        // 音声も追加
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".aac": "audio/aac",
        ".m4a": "audio/mp4",
        ".flac": "audio/flac",
        ".opus": "audio/opus"
      };
      let mimeType = void 0;
      const matched = Object.keys(extensionMimeMap).find((ext) => dataURL.toLowerCase().endsWith(ext));
      if (matched) {
        mimeType = extensionMimeMap[matched];
        if ((mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) && notSupportedAudioAndVideo) {
          log3.trace(`Audio and video not supported in this model ${this.model}`, dataURL);
          return;
        }
      }
      parts.push({ fileData: { fileUri: dataURL, mimeType } });
    } else {
      const mimeEnd = dataURL.indexOf(";");
      const mimeType = dataURL.substring("data:".length, mimeEnd);
      if ((mimeType?.startsWith("audio/") || mimeType?.startsWith("video/")) && notSupportedAudioAndVideo) {
        log3.trace(`Audio and video not supported in this model ${this.model}`, dataURL);
        return;
      }
      const data = dataURL.substring(mimeEnd + ";base64,".length);
      parts.push({ inlineData: { mimeType, data } });
    }
  }
  async getUsage(history, responseTokenCount) {
    const contents = [...history];
    let inputTokens = -1;
    let outputTokens = -1;
    try {
      inputTokens = (await this.generativeModels.countTokens({ model: this.model, contents })).totalTokens || 0;
      outputTokens = responseTokenCount;
    } catch (error) {
      if (error.message.indexOf("GoogleGenerativeAI Error") >= 0) {
        log3.info("Gemini 1.5 not support countTokens()?", error);
      } else {
        throw error;
      }
    }
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    };
  }
  imagesGenerate(_imageGeneratePrams) {
    throw new Error("GoogleGeminiAdapter does not support image generation.");
  }
};

// src/adapters/OpenAIAdapter.ts
import Log5 from "debug-level";
import OpenAI from "openai";
Log5.options({ json: true, colors: true });
var log4 = new Log5("OpenAI");
var OpenAIAdapter = class {
  openai;
  baseURL;
  constructor(openaiArgs) {
    this.openai = new OpenAI(openaiArgs);
    this.baseURL = this.openai.baseURL;
  }
  async createMessage(options) {
    try {
      const response = await this.openai.chat.completions.create(options);
      return { response, images: [] };
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        log4.error(`OpenAI API Error: ${error.status} ${error.name}`, error);
      }
      throw error;
    }
  }
  async imagesGenerate(imageGeneratePrams) {
    const result = await this.openai.images.generate(imageGeneratePrams);
    if ("on" in result) {
      throw new Error("Stream response is not supported in imagesGenerate");
    }
    return result;
  }
};

// src/config.ts
import fs from "fs";
import yaml from "js-yaml";
var ConfigLoader = class _ConfigLoader {
  // configCacheの型をConfigFile | nullに変更
  static instance;
  configCache = null;
  constructor() {
  }
  // シングルトンインスタンスを取得
  static getInstance() {
    if (!_ConfigLoader.instance) {
      _ConfigLoader.instance = new _ConfigLoader();
    }
    return _ConfigLoader.instance;
  }
  // 設定ファイルを取得（キャッシュあり）
  getConfig() {
    if (this.configCache) {
      return this.configCache;
    }
    const configFileName = process.env.CONFIG_FILE || "./config.yaml";
    if (!fs.existsSync(configFileName)) {
      this.configCache = {};
      return this.configCache;
    }
    const fileContents = fs.readFileSync(configFileName, "utf8");
    const data = yaml.load(fileContents);
    this.configCache = data;
    return data;
  }
  // AIプロバイダーの設定リストを取得
  getAIProvidersConfig() {
    const config2 = this.getConfig();
    const providers = (config2.bots || []).map((bot) => ({
      name: bot.name,
      type: bot.type,
      apiKey: bot.apiKey,
      apiBase: bot.apiBase,
      modelName: bot.modelName,
      visionModelName: bot.visionModelName,
      imageModelName: bot.imageModelName,
      apiVersion: bot.apiVersion,
      instanceName: bot.instanceName,
      deploymentName: bot.deploymentName,
      visionKey: bot.visionKey,
      visionInstanceName: bot.visionInstanceName,
      visionDeploymentName: bot.visionDeploymentName,
      imageKey: bot.imageKey,
      imageInstanceName: bot.imageInstanceName,
      imageDeploymentName: bot.imageDeploymentName,
      reasoningEffort: bot.reasoningEffort,
      verbosity: bot.verbosity
    }));
    return providers;
  }
};
function getConfig() {
  return ConfigLoader.getInstance().getConfig();
}

// src/OpenAIWrapper.ts
var OpenAIWrapper = class _OpenAIWrapper {
  name;
  provider;
  plugins = /* @__PURE__ */ new Map();
  functions = [];
  MAX_TOKENS;
  TEMPERATURE;
  MAX_PROMPT_TOKENS;
  REASONING_EFFORT;
  VERBOSITY;
  getMaxPromptTokens() {
    return this.MAX_PROMPT_TOKENS;
  }
  mattermostCLient;
  getMattermostClient() {
    return this.mattermostCLient;
  }
  /**
   * 環境変数に基づいてOpenAIモデル名を取得します。
   *
   * @param defaultModelName - デフォルトのモデル名。
   * @returns 環境変数 `OPENAI_API_KEY` が設定されている場合は  `defaultModelName`  を返し、
   *          そうでない場合は環境変数 `OPENAI_MODEL_NAME` を返します。
   */
  getOpenAIModelName(defaultModelName) {
    return (process.env["OPENAI_API_KEY"] ? void 0 : process.env["OPENAI_MODEL_NAME"]) && defaultModelName;
  }
  // eslint-disable-next-line max-lines-per-function
  constructor(providerConfig, mattermostClient) {
    this.mattermostCLient = mattermostClient;
    const yamlConfig = getConfig();
    this.MAX_TOKENS = providerConfig.maxTokens ?? Number(yamlConfig.OPENAI_MAX_TOKENS ?? process.env["OPENAI_MAX_TOKENS"] ?? 2e3);
    this.TEMPERATURE = providerConfig.temperature ?? Number(yamlConfig.OPENAI_TEMPERATURE ?? process.env["OPENAI_TEMPERATURE"] ?? 1);
    this.MAX_PROMPT_TOKENS = providerConfig.maxPromptTokens ?? Number(yamlConfig.MAX_PROMPT_TOKENS ?? process.env["MAX_PROMPT_TOKENS"] ?? 2e3);
    this.REASONING_EFFORT = providerConfig.reasoningEffort;
    this.VERBOSITY = providerConfig.verbosity;
    this.name = providerConfig.name;
    if (!this.name) {
      openAILog.error("No name. Ignore provider config", providerConfig);
      throw new Error("No Ignore provider config");
    }
    let chatProvider;
    let imageProvider = void 0;
    let visionProvider = void 0;
    switch (providerConfig.type) {
      case "azure": {
        const apiVersion = providerConfig.apiVersion ?? process.env["AZURE_OPENAI_API_VERSION"] ?? "2024-10-21";
        const apiKey = this.compensateAPIKey(providerConfig.apiKey, "AZURE_OPENAI_API_KEY");
        const instanceName = providerConfig.instanceName ?? process.env["AZURE_OPENAI_API_INSTANCE_NAME"];
        if (!instanceName) {
          openAILog.error(`${this.name} No Azure instanceName. Ignore provider config`, providerConfig);
          throw new Error(`${this.name} No Azure instanceName. Ignore provider config`);
        }
        const deploymentName = providerConfig.deploymentName ?? process.env["AZURE_OPENAI_API_DEPLOYMENT_NAME"];
        if (!deploymentName) {
          openAILog.error(`${this.name} No Azure deploymentName. Ignore provider config`, providerConfig);
          throw new Error(`${this.name} No Azure deploymentName. Ignore provider config`);
        }
        chatProvider = new OpenAIAdapter({
          apiKey,
          baseURL: `https://${instanceName}.openai.azure.com/openai/deployments/${deploymentName}`,
          //  新しいエンドポイントは以下だけど上のURLでも行ける
          //        https://${instanceName}.cognitiveservices.azure.com/openai/deployments/${deploymentName}
          defaultQuery: { "api-version": apiVersion },
          defaultHeaders: { "api-key": apiKey }
        });
        const imageKey = providerConfig.imageKey ?? process.env["AZURE_OPENAI_API_IMAGE_KEY"];
        const imageInstanceName = providerConfig.imageInstanceName ?? process.env["AZURE_OPENAI_API_IMAGE_INSTANCE_NAME"] ?? instanceName;
        const imageDeploymentName = providerConfig.imageDeploymentName ?? process.env["AZURE_OPENAI_API_IMAGE_DEPLOYMENT_NAME"];
        if (imageKey && imageDeploymentName) {
          imageProvider = new OpenAIAdapter({
            // Azureは東海岸(dall-e-2)やスエーデン(dall-e-3)しかDALL-Eが無いので新規に作る
            apiKey: imageKey,
            baseURL: `https://${imageInstanceName}.openai.azure.com/openai/deployments/${imageDeploymentName}`,
            defaultQuery: { "api-version": apiVersion },
            defaultHeaders: { "api-key": imageKey }
          });
        }
        const visionKey = providerConfig.visionKey ?? process.env["AZURE_OPENAI_API_VISION_KEY"];
        const visionInstanceName = providerConfig.visionInstanceName ?? process.env["AZURE_OPENAI_API_VISION_INSTANCE_NAME"] ?? instanceName;
        const visionDeploymentName = providerConfig.visionDeploymentName ?? process.env["AZURE_OPENAI_API_VISION_DEPLOYMENT_NAME"] ?? deploymentName;
        if (visionKey && visionDeploymentName) {
          visionProvider = new OpenAIAdapter({
            apiKey: visionKey,
            baseURL: `https://${visionInstanceName}.openai.azure.com/openai/deployments/${visionDeploymentName}`,
            defaultQuery: { "api-version": apiVersion },
            defaultHeaders: { "api-key": visionKey }
          });
        }
        providerConfig.visionInstanceName = visionInstanceName;
        providerConfig.visionDeploymentName = visionDeploymentName;
        ({ imageProvider, visionProvider } = this.setImageAndVisionProvider(
          providerConfig,
          imageProvider,
          visionProvider
        ));
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? deploymentName ?? "gpt-4o-mini",
          imageModelName: providerConfig.imageModelName ?? imageDeploymentName ?? "dall-e-3",
          visionModelName: providerConfig.visionModelName ?? visionDeploymentName ?? "gpt-4v"
        };
        break;
      }
      case "anthropic": {
        const apiKey = this.compensateAPIKey(providerConfig.apiKey, "ANTHROPIC_API_KEY");
        chatProvider = new AnthropicAdapter({ apiKey });
        ({ imageProvider, visionProvider } = this.setImageAndVisionProvider(
          providerConfig,
          imageProvider,
          visionProvider
        ));
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? this.getOpenAIModelName("claude-3-opus-20240229"),
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName
        };
        break;
      }
      case "cohere": {
        const apiKey = this.compensateAPIKey(providerConfig.apiKey, "COHERE_API_KEY");
        chatProvider = new CohereAdapter({ apiKey });
        ({ imageProvider, visionProvider } = this.setImageAndVisionProvider(
          providerConfig,
          imageProvider,
          visionProvider
        ));
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? this.getOpenAIModelName("command-r-plus"),
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName
        };
        break;
      }
      case "google": {
        const apiKey = this.compensateAPIKey(providerConfig.apiKey, "GOOGLE_API_KEY");
        const modelName = providerConfig.modelName ?? this.getOpenAIModelName("gemini-1.5-flash");
        chatProvider = new GoogleGeminiAdapter(apiKey, modelName, this.MAX_TOKENS, this.TEMPERATURE);
        if (!imageProvider) {
          imageProvider = chatProvider;
        }
        visionProvider = void 0;
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName,
          imageModelName: providerConfig.imageModelName,
          visionModelName: providerConfig.visionModelName
        };
        break;
      }
      case "openai": {
        const apiKey = this.compensateAPIKey(providerConfig.apiKey, "OPENAI_API_KEY");
        chatProvider = new OpenAIAdapter({
          apiKey,
          baseURL: providerConfig.apiBase ?? process.env["OPENAI_API_BASE"]
        });
        if (providerConfig.imageModelName) {
          imageProvider = chatProvider;
        }
        if (providerConfig.visionModelName) {
          visionProvider = chatProvider;
        }
        this.provider = {
          chatProvider,
          imageProvider,
          visionProvider,
          type: providerConfig.type,
          modelName: providerConfig.modelName ?? process.env["OPENAI_MODEL_NAME"] ?? "gpt-4o-mini",
          imageModelName: providerConfig.imageModelName ?? process.env["OPENAI_IMAGE_MODEL_NAME"] ?? "dall-e-3",
          visionModelName: providerConfig.visionModelName ?? process.env["OPENAI_VISION_MODEL_NAME"] ?? "gpt-4v"
        };
        break;
      }
      default:
        openAILog.error(`${this.name} Unknown LLM provider type. ${providerConfig.type}`, providerConfig);
        throw new Error(`${this.name} Unknown LLM provider type. ${providerConfig.type}`);
    }
    openAILog.debug(`AIProvider: ${providerConfig.name}`, this.provider.type, this.provider.modelName);
  }
  compensateAPIKey(apiKey, envName) {
    apiKey = apiKey ?? process.env[envName];
    if (!apiKey) {
      openAILog.error(`${this.name} No apiKey. Ignore provider config`);
      throw new Error(`${this.name} No apiKey. Ignore provider config`);
    }
    return apiKey;
  }
  setImageAndVisionProvider(providerConfig, imageProvider, visionProvider) {
    if (!providerConfig.imageModelName && !providerConfig.imageDeploymentName && imageProvider) {
      imageProvider = void 0;
    }
    if (!providerConfig.visionModelName && !providerConfig.visionDeploymentName && visionProvider) {
      visionProvider = void 0;
    }
    return { imageProvider, visionProvider };
  }
  getAIProvider() {
    return this.provider;
  }
  getAIProvidersName() {
    return this.name;
  }
  registerChatPlugin(plugin) {
    this.plugins.set(plugin.key, plugin);
    this.functions.push({
      name: plugin.key,
      description: plugin.description,
      parameters: {
        type: "object",
        properties: plugin.pluginArguments,
        required: plugin.requiredArguments
      }
    });
  }
  /**
   * Sends a message thread to chatGPT. The response can be the message responded by the AI model or the result of a
   * plugin call.
   * @param messages The message thread which should be sent.
   * @param msgData The message data of the last mattermost post representing the newest message in the message thread.
   * @param provider The provider to use for the chat completion.
   */
  // eslint-disable-next-line max-lines-per-function
  async continueThread(messages, msgData) {
    this.logMessages(messages);
    const NO_MESSAGE = "Sorry, but it seems I found no valid response.";
    const completionTokensDetails = {
      // accepted_prediction_tokens: 0,
      // audio_tokens: 0,
      reasoning_tokens: 0
      // rejected_prediction_tokens: 0,
    };
    const promptTokensDetails = {
      // audio_tokens: 0,
      cached_tokens: 0
    };
    let aiResponse = {
      message: NO_MESSAGE,
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        completion_tokens_details: completionTokensDetails,
        prompt_tokens_details: promptTokensDetails,
        total_tokens: 0
      },
      model: ""
    };
    let maxChainLength = 7;
    const missingPlugins = /* @__PURE__ */ new Set();
    let isIntermediateResponse = true;
    while (isIntermediateResponse && maxChainLength-- > 0) {
      const { responseMessage, finishReason, usage, model, images } = await this.createChatCompletion(
        messages,
        this.functions
      );
      this.makeModelAndUsage(aiResponse, model, usage);
      if (images) {
        openAILog.debug("Image files: ", images.length);
        for (const image of images) {
          const form = new FormData();
          form.append("channel_id", msgData.post.channel_id);
          const filename = _OpenAIWrapper.createImageFileName(image.type);
          form.append("files", image, filename);
          const response = await this.getMattermostClient().getClient().uploadFile(form);
          openAILog.trace("Uploaded a file with id", response.file_infos[0].id);
          const fileId = response.file_infos[0].id;
          aiResponse.message = "";
          aiResponse.props = {
            originalMessage: ""
          };
          if (!aiResponse.fileId) {
            aiResponse.fileId = [];
          }
          aiResponse.fileId.push(fileId);
        }
      }
      if (responseMessage) {
        if (responseMessage.function_call) {
          if (!responseMessage.tool_calls) {
            responseMessage.tool_calls = [];
          }
          responseMessage.tool_calls.push({
            id: "",
            type: "function",
            function: responseMessage.function_call
          });
        }
        if (responseMessage.tool_calls) {
          await Promise.all(
            responseMessage.tool_calls.map(async (tool_call) => {
              if (tool_call.type !== "function") {
                return;
              }
              const pluginName = tool_call.function.name;
              openAILog.trace({ pluginName });
              try {
                const plugin = this.plugins.get(pluginName);
                if (plugin) {
                  aiResponse.model += pluginName + " ";
                  const pluginArguments = JSON.parse(tool_call.function.arguments ?? "[]");
                  openAILog.trace({ plugin, pluginArguments });
                  const pluginResponse = await plugin.runPlugin(pluginArguments, msgData, this);
                  openAILog.trace({ pluginResponse });
                  if (pluginResponse.intermediate) {
                    messages.push({
                      role: "function",
                      //ChatCompletionResponseMessageRoleEnum.Function,
                      name: pluginName,
                      content: pluginResponse.message
                    });
                    return;
                  }
                  pluginResponse.model = aiResponse.model;
                  pluginResponse.usage = aiResponse.usage;
                  aiResponse = pluginResponse;
                } else {
                  if (!missingPlugins.has(pluginName)) {
                    missingPlugins.add(pluginName);
                    openAILog.debug({
                      error: "Missing plugin " + pluginName,
                      pluginArguments: tool_call.function.arguments
                    });
                    messages.push({
                      role: "system",
                      content: `There is no plugin named '${pluginName}' available. Try without using that plugin.`
                    });
                    return;
                  } else {
                    openAILog.debug({ messages });
                    aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`;
                  }
                }
              } catch (e) {
                openAILog.debug({ messages, error: e });
                aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`;
              }
            })
          );
        } else if (responseMessage.content) {
          if (NO_MESSAGE === aiResponse.message) {
            aiResponse.message = responseMessage.content;
          } else {
            aiResponse.message += responseMessage.content;
          }
          if (finishReason === "length") {
            messages.push({
              role: "assistant",
              content: responseMessage.content
            });
            continue;
          }
        }
      }
      isIntermediateResponse = false;
    }
    return aiResponse;
  }
  /**
   * 現在の日付と時刻をもとに画像ファイル名（imageYYYYMMDDhhmmssSSS.png）を生成します。
   * @returns 生成された画像ファイル名（例: image20240607_153012123.png）
   */
  static createImageFileName(mimeType) {
    const now = /* @__PURE__ */ new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, "0");
    const dd = now.getDate().toString().padStart(2, "0");
    const hh = now.getHours().toString().padStart(2, "0");
    const min = now.getMinutes().toString().padStart(2, "0");
    const ss = now.getSeconds().toString().padStart(2, "0");
    const ms = now.getMilliseconds().toString().padStart(3, "0");
    let filename = `image${yyyy}${mm}${dd}${hh}${min}${ss}${ms}.png`;
    if (mimeType.startsWith("image/")) {
      filename = `image${yyyy}${mm}${dd}${hh}${min}${ss}${ms}.png`;
    } else if (mimeType.startsWith("audio/mp3")) {
      filename = `audio${yyyy}${mm}${dd}${hh}${min}${ss}${ms}.mp3`;
    } else if (mimeType.startsWith("audio/")) {
      filename = `audio${yyyy}${mm}${dd}${hh}${min}${ss}${ms}.wav`;
    }
    return filename;
  }
  makeModelAndUsage(aiResponse, model, usage) {
    aiResponse.model += model + " ";
    if (usage && aiResponse.usage) {
      aiResponse.usage.prompt_tokens += usage.prompt_tokens;
      aiResponse.usage.prompt_tokens_details.cached_tokens += usage?.prompt_tokens_details?.cached_tokens ? usage.prompt_tokens_details.cached_tokens : 0;
      aiResponse.usage.completion_tokens += usage.completion_tokens;
      aiResponse.usage.completion_tokens_details.reasoning_tokens += usage?.completion_tokens_details?.reasoning_tokens ? usage.completion_tokens_details.reasoning_tokens : 0;
      aiResponse.usage.total_tokens += usage.total_tokens;
    }
  }
  /**
   * Logs the provided messages array after serializing and shortening long image URLs.
   *
   * @param {OpenAI.Chat.Completions.ChatCompletionMessageParam[]} messages - An array of chat completion messages.
   */
  logMessages(messages) {
    openAILog.trace(
      "messages: ",
      //シリアライズでDeep Copy
      JSON.parse(JSON.stringify(messages)).map((message) => {
        if (typeof message.content !== "string") {
          message.content?.forEach((content) => {
            if (content.type === "image_url") {
              const contentPartImage = content;
              const url = shortenString(contentPartImage.image_url?.url);
              if (url) {
                contentPartImage.image_url.url = url;
              }
            } else if (content.type === "file") {
              const contentPartFile = content;
              const fileData = shortenString(contentPartFile.file?.file_data);
              if (fileData) {
                contentPartFile.file.file_data = fileData;
              }
            } else if (content.type === "input_audio") {
              const contentPartAudio = content;
              const audioData = shortenString(contentPartAudio.input_audio?.data);
              if (audioData) {
                contentPartAudio.input_audio.data = audioData;
              }
            }
          });
        }
        return message;
      })
    );
  }
  /**
   * Creates a openAI chat model response.
   * @param messages The message history the response is created for.
   * @param functions Function calls which can be called by the openAI model
   * @param provider The provider to use for the chat completion.
   *
   */
  // eslint-disable-next-line max-lines-per-function
  async createChatCompletion(messages, functions = void 0) {
    let useTools = true;
    const currentProvider = this.getAIProvider();
    let currentOpenAi = currentProvider.chatProvider;
    let currentModel = currentProvider.modelName;
    if (currentProvider.type === "anthropic") {
      useTools = false;
    } else if (currentProvider.visionModelName) {
      messages.some((message) => {
        if (typeof message.content !== "string") {
          if (currentProvider.visionModelName.indexOf("gpt-4v") >= 0) {
            useTools = false;
          }
          if (currentProvider.visionProvider) {
            currentOpenAi = currentProvider.visionProvider;
          }
          currentModel = currentProvider.visionModelName;
          return true;
        }
      });
    }
    const chatCompletionOptions = {
      model: currentModel,
      messages,
      temperature: this.TEMPERATURE
    };
    const useMaxCompletionTokens = [
      // Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.
      // とりあえずgpt-5やo1,o4,o4で始まるモデルはすべてmax_completion_tokensを使う
      "gpt-5",
      "o4",
      "o3",
      "o1"
    ].some((model) => currentModel.startsWith(model));
    if (useMaxCompletionTokens) {
      chatCompletionOptions.max_completion_tokens = this.MAX_TOKENS;
    } else {
      chatCompletionOptions.max_tokens = this.MAX_TOKENS;
    }
    if (this.REASONING_EFFORT) {
      chatCompletionOptions.reasoning_effort = this.REASONING_EFFORT;
    }
    if (this.VERBOSITY) {
      chatCompletionOptions.verbosity = this.VERBOSITY;
    }
    if (functions && useTools) {
      if (currentModel.indexOf("gpt-3") >= 0) {
        chatCompletionOptions.functions = functions;
        chatCompletionOptions.function_call = "auto";
      } else {
        chatCompletionOptions.tools = functions.map((func) => ({ type: "function", function: func }));
        chatCompletionOptions.tool_choice = "auto";
      }
    }
    this.logChatCompletionsCreateParameters(chatCompletionOptions);
    const ret = await currentOpenAi.createMessage(chatCompletionOptions);
    const chatCompletion = ret.response;
    openAILog.trace({ chatCompletion });
    return {
      responseMessage: chatCompletion.choices?.[0]?.message,
      usage: chatCompletion.usage,
      model: chatCompletion.model,
      finishReason: chatCompletion.choices?.[0]?.finish_reason,
      images: ret.images
    };
  }
  /**
   * Logs the parameters used for creating a chat completion in OpenAI.
   *
   * @param chatCompletionOptions - The options provided to create a chat completion.
   */
  logChatCompletionsCreateParameters(chatCompletionOptions) {
    openAILog.trace("chat.completions.create() Parameters", {
      model: chatCompletionOptions.model,
      max_tokens: chatCompletionOptions.max_tokens,
      max_completion_tokens: chatCompletionOptions.max_completion_tokens,
      temperature: chatCompletionOptions.temperature,
      reasoning_effort: chatCompletionOptions.reasoning_effort,
      verbosity: chatCompletionOptions.verbosity,
      function_call: chatCompletionOptions.function_call,
      functions: chatCompletionOptions.functions?.map(
        (func) => `${func.name}(${this.toStringParameters(func.parameters)}): ${func.description}`
      ),
      tools_choice: chatCompletionOptions.tool_choice,
      tools: chatCompletionOptions.tools?.map(
        (tool) => (
          // tool.typeが'function'の場合のみfunctionプロパティにアクセスする
          tool.type === "function" && "function" in tool ? `${tool.type} ${tool.function.name}(${this.toStringParameters(tool.function.parameters)}): ${tool.function.description}` : `${tool.type}`
        )
        //こちらの場合functionではないのでその旨をlogに出力
      )
    });
  }
  // Function Parametersのプロパティを文字列に展開する
  toStringParameters(parameters) {
    if (!parameters) {
      return "";
    }
    let string = "";
    const props = parameters.properties;
    for (const paramKey in props) {
      if (string.length > 0) {
        string += ", ";
      }
      string += `${paramKey}:${props[paramKey].type}`;
    }
    return string;
  }
  /**
   * Creates a openAI DALL-E response.
   * @param prompt The image description provided to DALL-E.
   */
  async createImage(prompt) {
    const currentProvider = this.getAIProvider();
    const createImageOptions = {
      model: currentProvider.imageModelName,
      prompt,
      n: 1,
      size: "1024x1024",
      //Must be one of 256x256, 512x512, or 1024x1024 for dall-e-2. Must be one of 1024x1024, 1792x1024, or 1024x1792 for dall-e-3 models.
      quality: "standard",
      //"hd", $0.080/枚=1枚12円で倍額
      response_format: "b64_json"
    };
    openAILog.trace({ createImageOptions });
    let image;
    if (currentProvider.type !== "azure" || currentProvider.imageModelName !== "dall-e-2") {
      image = await currentProvider.imageProvider.imagesGenerate(createImageOptions);
    } else {
      image = await currentProvider.imageProvider.imagesGenerate(createImageOptions);
    }
    const dataTmp = image.data?.[0]?.b64_json;
    if (dataTmp) {
      image.data[0].b64_json = shortenString(dataTmp);
    }
    openAILog.trace("images.generate", { image });
    if (dataTmp) {
      image.data[0].b64_json = dataTmp;
    }
    return image.data?.[0]?.b64_json;
  }
};

// src/plugins/ImagePlugin.ts
var ImagePlugin = class extends PluginBase {
  GPT_INSTRUCTIONS = "You are a prompt engineer who helps a user to create good prompts for the image AI DALL-E. The user will provide you with a short image description and you transform this into a proper prompt text. When creating the prompt first describe the looks and structure of the image. Secondly, describe the photography style, like camera angle, camera position, lenses. Third, describe the lighting and specific colors. Your prompt have to focus on the overall image and not describe any details on it. Consider adding buzzwords, for example 'detailed', 'hyper-detailed', 'very realistic', 'sketchy', 'street-art', 'drawing', or similar words. Keep the prompt as simple as possible and never get longer than 400 characters. You may only answer with the resulting prompt and provide no description or explanations.";
  setup(plugins) {
    this.addPluginArgument("imageDescription", "string", "The description of the image provided by the user");
    if (!this.isEnable(plugins, "image-plugin")) return false;
    return super.setup(plugins);
  }
  async runPlugin(args, msgData, openAIWrapper) {
    const aiResponse = {
      message: "Sorry, I could not execute the image plugin."
    };
    try {
      const imagePrompt = await this.createImagePrompt(args.imageDescription, openAIWrapper);
      if (imagePrompt) {
        this.log.trace({ imageInputPrompt: args.imageDescription, imageOutputPrompt: imagePrompt });
        const base64Image = (
          /*this.img256 //*/
          /*this.sampleB64String */
          await openAIWrapper.createImage(imagePrompt)
        );
        if (base64Image) {
          const fileId = await this.base64ToFile(
            base64Image,
            msgData.post.channel_id,
            openAIWrapper.getMattermostClient().getClient()
          );
          aiResponse.message = "Here is the image you requested: " + imagePrompt;
          aiResponse.props = {
            originalMessage: "Sure here is the image you requested. <IMAGE>" + imagePrompt + "</IMAGE>"
          };
          aiResponse.fileId = [fileId];
        }
      }
    } catch (e) {
      this.log.error(e);
      this.log.error(`The input was:

${args.imageDescription}`);
      aiResponse.message += `
${e.message}
The input was:${args.imageDescription}`;
    }
    return aiResponse;
  }
  async createImagePrompt(userInput, openAIWrapper) {
    const messages = [
      {
        role: "system",
        //ChatCompletionRequestMessageRoleEnum.System,
        content: this.GPT_INSTRUCTIONS
      },
      {
        role: "user",
        //ChatCompletionRequestMessageRoleEnum.User,
        content: userInput
      }
    ];
    const response = await openAIWrapper.createChatCompletion(messages, void 0);
    return response?.responseMessage?.content;
  }
  async base64ToFile(b64String, channelId, mattermostClient) {
    const form = new FormData();
    form.append("channel_id", channelId);
    const fileName = OpenAIWrapper.createImageFileName("image/png");
    form.append("files", new Blob([Buffer.from(b64String, "base64")], { type: "image/png" }), fileName);
    const response = await mattermostClient.uploadFile(form);
    this.log.trace("Uploaded a file with id", response.file_infos[0].id);
    return response.file_infos[0].id;
  }
};

// src/plugins/MessageCollectPlugin.ts
var MessageCollectPlugin = class extends PluginBase {
  setup(plugins) {
    this.addPluginArgument(
      "lookBackTime",
      "number",
      "The time in milliseconds to look back in time and collect messages which were posted within this timespan. Omit this parameter if the collected messages are independent from the time they were sent.",
      true
    );
    this.addPluginArgument(
      "messageCount",
      "number",
      "The number of messages which should be collected. Omit this parameter if you want to collect all messages.",
      true
    );
    if (!this.isEnable(plugins, "message-collect-plugin")) return false;
    return super.setup(plugins);
  }
  async runPlugin(args, msgData, openAIWrapper) {
    this.log.trace(args);
    return {
      message: JSON.stringify(
        await this.getPosts(
          msgData.post,
          { lookBackTime: args.lookBackTime, postCount: args.messageCount },
          openAIWrapper.getMattermostClient().getClient()
        )
      ),
      intermediate: true
    };
  }
  async getPosts(refPost, options, client4) {
    const thread = await client4.getPostThread(refPost.id, true, false, true);
    let posts = [...new Set(thread.order)].map((id) => thread.posts[id]).sort((a, b) => a.create_at - b.create_at);
    if (options.lookBackTime && options.lookBackTime > 0) {
      posts = posts.filter((a) => a.create_at > refPost.create_at - options.lookBackTime);
    }
    if (options.postCount && options.postCount > 0) {
      posts = posts.slice(-options.postCount);
    }
    const result = [];
    const meId = (await client4.getMe())?.id;
    for (const threadPost of posts) {
      if (threadPost.user_id === meId) {
        result.push({
          content: threadPost.props.originalMessage ?? threadPost.message
        });
      } else {
        result.push({
          content: threadPost.message
        });
      }
    }
    return result;
  }
};

// src/plugins/UnuseImagesPlugin.ts
var UnuseImagesPlugin = class extends PluginBase {
  async runPlugin(_args, _msgData, openAIWrapper) {
    return {
      message: "No use images! :stop_sign:\n```" + openAIWrapper.getAIProvidersName() + " left the conversation.```",
      props: { bot_images: "stopped" }
    };
  }
};

// src/tokenCount.ts
import tiktoken from "tiktoken-node";
var enc = tiktoken.encodingForModel("gpt-3.5-turbo");
function tokenCount(content) {
  if (!content) return 0;
  const tokens = enc.encode(content);
  return tokens.length;
}

// src/postMessage.ts
async function postMessage(botService, msgData, messages, meId, MAX_PROMPT_TOKENS) {
  const typing = () => botService.getMattermostClient().getWsClient().userTyping(msgData.post.channel_id, (msgData.post.root_id || msgData.post.id) ?? "");
  typing();
  const typingInterval = setInterval(typing, 2e3);
  let answer = "";
  let { sumMessagesCount, messagesCount } = calcMessagesTokenCount(messages);
  try {
    let systemMessage = SYSTEM_MESSAGE_HEADER;
    ({
      messages,
      sumMessagesCount,
      messagesCount,
      systemMessage
    } = expireMessages(messages, sumMessagesCount, messagesCount, systemMessage, MAX_PROMPT_TOKENS));
    if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
      newPost(botService, systemMessage, msgData.post, void 0, void 0);
    }
    if (sumMessagesCount >= MAX_PROMPT_TOKENS) {
      botLog.info("Too long user message", sumMessagesCount, MAX_PROMPT_TOKENS);
      try {
        answer = await failSafeCheck(messages, answer);
      } catch (e) {
        if (e instanceof TypeError) {
          newPost(botService, SYSTEM_MESSAGE_HEADER + e.message, msgData.post, void 0, void 0);
          return;
        }
        throw e;
      }
      let lines = [];
      if (typeof messages[1].content === "string") {
        lines = messages[1].content.split("\n");
      } else {
        if (messages[1].content) {
          for (let i = 0; messages[1].content.length > i; i++) {
            if (messages[1].content[i].type === "text") {
              lines.push(...messages[1].content[i].text.split("\n"));
            }
          }
        }
      }
      if (lines.length < 1) {
        botLog.error("No contents", messages[1].content);
        answer += "No contents.";
        newPost(botService, SYSTEM_MESSAGE_HEADER + answer, msgData.post, void 0, void 0);
        return;
      }
      const linesCount = [];
      lines.forEach((line, i) => {
        if (lines) {
          if (line === "") {
            lines[i] = "\n";
            linesCount[i] = 1;
          } else {
            lines[i] += "\n";
            linesCount[i] = tokenCount(lines[i]);
          }
        }
      });
      if (messagesCount[0] + linesCount[0] >= MAX_PROMPT_TOKENS) {
        botLog.warn("Too long first line", lines[0]);
        answer += "Too long first line.\n```\n" + lines[0] + "```\n";
        newPost(botService, SYSTEM_MESSAGE_HEADER + answer, msgData.post, void 0, void 0);
        return;
      }
      let partNo = 0;
      let currentMessages = [messages[0]];
      let currentMessagesCount = [messagesCount[0]];
      let sumCurrentMessagesCount = currentMessagesCount[0];
      for (let i = 1; i < lines.length; i++) {
        botLog.info("Separate part. No." + partNo);
        let currentLines = lines[0];
        let currentLinesCount = linesCount[0];
        let systemMessage2 = SYSTEM_MESSAGE_HEADER;
        while (currentMessages.length > 1 && (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= MAX_PROMPT_TOKENS || sumCurrentMessagesCount + currentLinesCount > MAX_PROMPT_TOKENS / 2)) {
          botLog.info("Remove assistant message", currentMessages[1]);
          systemMessage2 += mkMessageContentString(messages, "Forget previous message.");
          sumCurrentMessagesCount -= currentMessagesCount[1];
          currentMessagesCount = [currentMessagesCount[0], ...currentMessagesCount.slice(2)];
          currentMessages = [currentMessages[0], ...currentMessages.slice(2)];
        }
        if (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= MAX_PROMPT_TOKENS) {
          botLog.warn("Too long line", lines[i]);
          systemMessage2 += `*** No.${++partNo} *** Too long line.
~~~
${lines[i]}~~~
`;
          await newPost(botService, systemMessage2, msgData.post, void 0, void 0);
          continue;
        }
        if (systemMessage2 !== SYSTEM_MESSAGE_HEADER) {
          await newPost(botService, systemMessage2, msgData.post, void 0, void 0);
        }
        while (i < lines.length && sumCurrentMessagesCount + currentLinesCount + linesCount[i] < MAX_PROMPT_TOKENS) {
          currentLinesCount += linesCount[i];
          currentLines += lines[i++];
        }
        botLog.debug(`line done i=${i} currentLinesCount=${currentLinesCount} currentLines=${currentLines}`);
        currentMessages.push({
          role: "user",
          content: currentLines,
          name: await botService.userIdToName(msgData.post.user_id)
        });
        const {
          message: completion,
          usage,
          fileId,
          props,
          model
        } = await botService.getOpenAIWrapper().continueThread(currentMessages, msgData);
        answer += `*** No.${++partNo} ***
${completion}`;
        answer += makeUsageMessage(usage, model);
        botLog.debug("answer=" + answer);
        await newPost(botService, answer, msgData.post, fileId, props);
        answer = "";
        currentMessages.pop();
        currentMessages.push({ role: "assistant", content: answer, name: await botService.userIdToName(meId) });
        currentMessagesCount.push(currentLinesCount);
        if (usage) {
          sumCurrentMessagesCount += usage.completion_tokens;
        }
        botLog.debug("length=" + currentMessages.length);
      }
    } else {
      const {
        message: completion,
        usage,
        fileId,
        props,
        model
      } = await botService.getOpenAIWrapper().continueThread(messages, msgData);
      answer += completion;
      answer += makeUsageMessage(usage, model);
      await newPost(botService, answer, msgData.post, fileId, props);
      botLog.debug("answer=" + answer);
    }
  } catch (e) {
    botLog.error("Exception in postMessage()", e);
    answer += "\nSorry, but I encountered an internal error when trying to process your message";
    if (e instanceof Error) {
      answer += `
Error: ${e.message}`;
    }
    await newPost(botService, answer, msgData.post, void 0, void 0);
  } finally {
    clearInterval(typingInterval);
  }
  function makeUsageMessage(usage, model = "") {
    if (!usage && !model) return "";
    let message = `
${SYSTEM_MESSAGE_HEADER} `;
    if (usage) {
      message += ` Prompt:${usage.prompt_tokens} `;
      if (usage.prompt_tokens_details?.cached_tokens) {
        message += `Cached:${usage.prompt_tokens_details.cached_tokens} `;
      }
      message += `Completion:${usage.completion_tokens} `;
      if (usage.completion_tokens_details?.reasoning_tokens) {
        message += `Reasoning:${usage.completion_tokens_details.reasoning_tokens} `;
      }
      message += `Total:${usage.total_tokens}`;
    }
    if (model) {
      message += ` Model:${model}`;
    }
    return message;
  }
}
async function newPost(botService, answer, post, fileId, props) {
  const newPost2 = await botService.getMattermostClient().getClient().createPost({
    message: answer,
    channel_id: post.channel_id,
    props,
    root_id: post.root_id || post.id,
    file_ids: fileId ? fileId : void 0
  });
  botLog.trace({ newPost: newPost2 });
}
function calcMessagesTokenCount(messages) {
  let sumMessagesCount = 0;
  const messagesCount = new Array(messages.length);
  messages.forEach((message, i) => {
    messagesCount[i] = 0;
    if (typeof message.content === "string" && message.content.length > 0) {
      messagesCount[i] = tokenCount(message.content);
    } else if (typeof message.content === "object" && message.content) {
      message.content.forEach((content) => {
        if (content.type === "text") {
          messagesCount[i] += tokenCount(content.text);
        }
      });
    }
    sumMessagesCount += messagesCount[i];
  });
  return { sumMessagesCount, messagesCount };
}
async function failSafeCheck(messages, answer) {
  if (messages[0].role !== "system") {
    await throwTypeError(messages[0]);
  }
  if (messages[1].role !== "user") {
    await throwTypeError(messages[1]);
  }
  return answer;
  async function throwTypeError(message) {
    botLog.error("Invalid message", message);
    answer += mkMessageContentString(messages, `Invalid message. Role: ${message.role}`);
    throw new TypeError(answer);
  }
}
function expireMessages(messages, sumMessagesCount, messagesCount, systemMessage, MAX_PROMPT_TOKENS) {
  while (messages.length > 2 && sumMessagesCount >= MAX_PROMPT_TOKENS) {
    botLog.info("Remove message", messages[1]);
    systemMessage += mkMessageContentString(messages, "Forget old message.");
    sumMessagesCount -= messagesCount[1];
    messagesCount = [messagesCount[0], ...messagesCount.slice(2)];
    messages = [messages[0], ...messages.slice(2)];
  }
  return { messages, sumMessagesCount, messagesCount, systemMessage };
}
function mkMessageContentString(messages, description) {
  return `${description}
~~~
${(typeof messages[1].content === "string" ? messages[1].content : messages[1].content?.[0]?.type === "text" ? messages[1].content[0].text : "").split("\n").slice(0, 3).join("\n")}
...
~~~
`;
}

// src/BotService.ts
import sharp from "sharp";
if (!global.FormData) {
  global.FormData = FormData3;
}
var config = getConfig();
var contextMsgCount = Number(config.BOT_CONTEXT_MSG ?? process.env["BOT_CONTEXT_MSG"] ?? 100);
var SYSTEM_MESSAGE_HEADER = "// BOT System Message: ";
var additionalBotInstructions = config.BOT_INSTRUCTION ?? process.env["BOT_INSTRUCTION"] ?? "You are a helpful assistant. Whenever users asks you for help you will provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the meta data of the messages.";
var BotService2 = class {
  mattermostClient;
  meId;
  // ex. @ChatGPTのID
  name;
  // ex. @ChatGPT
  openAIWrapper;
  getMattermostClient() {
    return this.mattermostClient;
  }
  getOpenAIWrapper() {
    return this.openAIWrapper;
  }
  constructor(mattermostClient, meId, name, openAIWrapper, plugins) {
    this.mattermostClient = mattermostClient;
    this.meId = meId;
    this.name = name;
    this.openAIWrapper = openAIWrapper;
    const pluginsAvailable = [
      new GraphPlugin("graph-plugin", "Generate a graph based on a given description or topic"),
      new ImagePlugin("image-plugin", "Generates an image based on a given image description."),
      new ExitPlugin("exit-plugin", "Says goodbye to the user and wish him a good day."),
      new MessageCollectPlugin("message-collect-plugin", "Collects messages in the thread for a specific user or time"),
      new UnuseImagesPlugin("unuse-images-plugin", 'Ignore images when asked to "ignore images".')
      // 画像を無視してGPT-4に戻す まだGPT-4Vではfunction使えないけどね
    ];
    for (const plugin of pluginsAvailable) {
      if (plugin.setup(plugins)) {
        this.openAIWrapper.registerChatPlugin(plugin);
        botLog.trace(`${name} Registered plugin ${plugin.key}`);
      }
    }
  }
  // クライアントメッセージを処理する
  async onClientMessage(msg) {
    if (msg.event !== "posted" && msg.event !== "post_edited" || !this.meId) {
      matterMostLog.debug(`Event not posted: ${msg.event}`);
      return;
    }
    const msgData = this.parseMessageData(msg.data);
    const posts = await this.getOlderPosts(msgData.post, {
      lookBackTime: 1e3 * 60 * 60 * 24 * 7,
      postCount: contextMsgCount
    });
    if (await this.isMessageIgnored(msgData, posts)) {
      return;
    }
    matterMostLog.trace({ threadPosts: posts });
    const chatmessages = [
      {
        role: "system",
        // ChatCompletionRequestMessageRoleEnum.System,
        content: "Your name is " + this.name + ". " + additionalBotInstructions
      }
    ];
    await this.appendThreadPosts(posts, chatmessages, await this.isUnuseImages(posts));
    await postMessage(this, msgData, chatmessages, this.meId, this.openAIWrapper.getMaxPromptTokens());
  }
  /**
   * Appends thread posts to the chat messages array, formatting them based on the content and metadata.
   * 今までスレッドのPostを取得してChatMessageに組み立てる
   *
   * @param posts - An array of Post objects to be appended.
   * @param meId - The ID of the current user (bot).
   * @param chatmessages - An array of chat completion message parameters where the formatted messages will be appended.
   * @param unuseImages - A boolean indicating whether to omit images from the messages.
   */
  // スレッドの投稿をチャットメッセージに追加する
  // eslint-disable-next-line max-lines-per-function
  async appendThreadPosts(posts, chatmessages, unuseImages) {
    for (const threadPost of posts) {
      let role = "user";
      let message = threadPost.message;
      if (threadPost.user_id === this.meId) {
        role = "assistant";
        if (threadPost.props.originalMessage) {
          message = threadPost.props.originalMessage;
        }
      }
      if (!unuseImages && (threadPost.metadata.files?.length > 0 || threadPost.metadata.images || threadPost.metadata.embeds)) {
        role = "user";
        const content = [{ type: "text", text: message }];
        if (threadPost.metadata.files) {
          await Promise.all(
            threadPost.metadata.files.map(async (file) => {
              const originalUrl = await this.mattermostClient.getClient().getFileUrl(file.id, NaN);
              const url = await this.getBase64Image(
                originalUrl,
                this.mattermostClient.getClient().getToken(),
                file.mime_type || file.extension,
                // mime_typeがない場合は拡張子を使う
                file.width,
                file.height
              );
              if (url) {
                if ([
                  "pdf",
                  "x-javascript",
                  "javascript",
                  "x-python",
                  "plain",
                  "html",
                  "css",
                  "md",
                  "csv",
                  "xml",
                  "rtf"
                ].includes(file.mime_type.replace(/^.+\//, ""))) {
                  content.push({ type: "file", file: { filename: file.name, file_data: url } });
                } else {
                  content.push(
                    { type: "image_url", image_url: { url } }
                    //detail?: 'auto' | 'low' | 'high' はdefaultのautoで
                  );
                }
              }
            })
          );
        }
        const excludeImage = [];
        if (threadPost.metadata.embeds) {
          for (const embed of threadPost.metadata.embeds) {
            if (embed.url && embed.type === "link") {
              const url = await this.getBase64Image(embed.url, this.mattermostClient.getClient().getToken());
              if (url) {
                content.push({ type: "image_url", image_url: { url } });
              }
            } else if (embed.type === "opengraph" && embed.url && (embed.url.startsWith("https://youtu.be/") || embed.url.startsWith("https://www.youtube.com/"))) {
              const data = embed.data;
              if (data?.type === "opengraph" && data?.images?.[0]?.secure_url) {
                excludeImage.push(data.images[0].secure_url);
              }
              content.push({ type: "image_url", image_url: { url: embed.url } });
            }
            if (embed.type === "opengraph" && embed.url && embed.data && embed.data?.type === "website") {
              botLog.info(
                `Ignore embed type: ${embed.type} data.type=${embed.data?.type}, use images`
              );
            } else {
              botLog.warn(`Unsupported embed type: ${embed.type}. Skipping.`, embed);
            }
          }
        }
        if (threadPost.metadata.images) {
          await Promise.all(
            Object.keys(threadPost.metadata.images).map(async (url) => {
              if (!excludeImage.includes(url)) {
                const postImage = threadPost.metadata.images[url];
                url = await this.getBase64Image(
                  url,
                  this.mattermostClient.getClient().getToken(),
                  postImage.format,
                  postImage.width,
                  postImage.height
                );
                content.push({ type: "image_url", image_url: { url } });
              } else {
                botLog.info(`Skipping image URL: ${url} as it is in the exclude list.`);
              }
            })
          );
        }
        chatmessages.push({
          role,
          name: await this.userIdToName(threadPost.user_id),
          content
        });
      } else {
        chatmessages.push({
          role,
          name: await this.userIdToName(threadPost.user_id),
          content: message
        });
      }
    }
  }
  /**
   * 画像をBase64形式で取得します。
   *
   * @param url - 画像のURL。
   * @param token - 認証トークン（任意）。
   * @param format - 画像フォーマット（任意）。
   * @param width - 画像の幅（任意）。
   * @param height - 画像の高さ（任意）。
   * @returns Base64形式の画像データ。
   */
  // 画像をBase64形式で取得する //TODO: 関数も、画像の取得と変換を別の関数に分割することが考えられます。
  async getBase64Image(url, token = "", format = "", width = 0, height = 0) {
    const init = {};
    if (token) {
      init.headers = {
        Authorization: `Bearer ${token}`
        // Add the Authentication header here
      };
    }
    let dataURL = "";
    if (["pdf", "x-javascript", "javascript", "x-python", "plain", "html", "css", "md", "csv", "xml", "rtf"].includes(
      format.replace(/^.+\//, "")
    )) {
      matterMostLog.info(`Find Document file ${format} ${url}`);
      format = this.toMimeType(format, "text");
    } else if (["mov", "mpeg", "mp4", "mpg", "avi", "wmv", "mpegps", "flv"].includes(format.replace(/^.+\//, ""))) {
      format = this.toMimeType(format, "video");
      dataURL = await this.makeLargeDataURL(url, init, format);
    } else if (["mp3", "wav", "ogg"].includes(format.replace(/^.+\//, ""))) {
      format = this.toMimeType(format, "audio");
      dataURL = await this.makeLargeDataURL(url, init, format);
    } else {
      let buffer = await this.fetchData(url, init);
      ({ format, width, height, buffer } = await this.convertImage(format, width, height, buffer));
      if (buffer.length > 0) {
        dataURL = this.makeDataURL(format, buffer);
      }
    }
    return dataURL;
  }
  // 大きなファイルの時も対応したdataURLを作る
  async makeLargeDataURL(url, init, mimeType) {
    const downloadSize = await this.getDownloadSize(url, init).catch((error) => {
      botLog.error(`Fetch HEAD \u30A8\u30E9\u30FC: ${error}`);
      return 0;
    });
    if (downloadSize > 2 * 1024 * 1024 * 1024) {
      matterMostLog.warn(`File size too large to embed in data URL: ${downloadSize} bytes. url: ${url}`);
      return "";
    }
    if (downloadSize > 20 * 1024 * 1024) {
      matterMostLog.info(`File size too large to embed in data URL: ${downloadSize} bytes. url: ${url}`);
      return "";
    }
    const buffer = await this.fetchData(url, init);
    return this.makeDataURL(mimeType, buffer);
  }
  // Convert buffer to a BASE64 data URL
  makeDataURL(mimeType, buffer) {
    const base64 = buffer.toString("base64");
    return "data:" + mimeType + ";base64," + base64;
  }
  // URLからデータをfetchする
  async fetchData(url, init) {
    const response = await fetch(url, init).catch((error) => {
      matterMostLog.error(`Fech Exception! url: ${url}`, error);
      return { ok: false };
    });
    if (!response.ok) {
      botLog.error(`Fetch Image URL HTTP error! status: ${response?.status}`);
      return Buffer.alloc(0);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
  }
  // 画像をOpenAIがサポートしている形式とサイズに変換する
  async convertImage(format, width, height, buffer) {
    if (!format || ["png", "jpeg", "webp", "gif"].includes(format.replace(/^.+\//, "")) && (width <= 0 || height <= 0)) {
      const metadata = await sharp(buffer).metadata();
      width = metadata.width ?? 0;
      height = metadata.height ?? 0;
      format = metadata.format ?? "";
    }
    if (!["png", "jpeg", "webp", "gif"].includes(format.replace(/^.+\//, ""))) {
      matterMostLog.warn(`Unsupported image format: ${format}. Converting to JPEG.`);
      buffer = await sharp(buffer).jpeg().toBuffer();
      ({ format = "", width = 0, height = 0 } = await sharp(buffer).metadata());
    }
    buffer = await this.resizeImage(width, height, buffer);
    format = this.toMimeType(format, "image");
    return { format, width, height, buffer };
  }
  // URLのファイルサイズを調べる
  async getDownloadSize(url, init) {
    try {
      const response = await fetch(url, { method: "HEAD", ...init });
      if (!response.ok) {
        botLog.error(`Fetch HEAD URL HTTP error! status: ${response?.status}`);
        throw new Error(`Fetch HEAD URL HTTP error! status: ${response.status}`);
      }
      const contentLength = response.headers.get("Content-Length");
      if (contentLength) {
        botLog.log(`\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u30B5\u30A4\u30BA: ${contentLength} \u30D0\u30A4\u30C8 ${url}`);
        return parseInt(contentLength, 10);
      } else {
        botLog.log(`Fetch HEAD Content-Length \u30D8\u30C3\u30C0\u30FC\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093\u3067\u3057\u305F\u3002 ${url}`);
        throw new Error(`Fetch HEAD URL Can't find Content-Length Header ${url}`);
      }
    } catch (error) {
      botLog.error("Fetch HEAD \u30A8\u30E9\u30FC:", error);
      throw error;
    }
  }
  /**
   * 指定された形式をMIMEタイプに変換します。
   *
   * @param format - 変換したいファイル形式を表す文字列。
   * @param mime - MIMEタイプのプレフィックス（例: 'image', 'video'）。
   * @returns 正しく形式化されたMIMEタイプ。
   */
  // 形式をMIMEタイプに変換する
  toMimeType(format, mime) {
    if (format.indexOf("/") < 0) {
      format = `${mime}/${format}`;
    }
    return format;
  }
  // 画像をリサイズする
  async resizeImage(width, height, buffer) {
    let resize = false;
    const shortEdge = 768;
    const longEdge = 1024;
    if (width > longEdge || height > longEdge) {
      const resizeRatio = longEdge / Math.max(width, height);
      width *= resizeRatio;
      height *= resizeRatio;
      resize = true;
    }
    if (Math.min(width, height) > shortEdge) {
      const resizeRatio = shortEdge / Math.min(width, height);
      botLog.info(
        `Resize image ${resizeRatio * 100}% ${width}x${height} to ${Math.round(width * resizeRatio)}x${Math.round(height * resizeRatio)}`
      );
      width *= resizeRatio;
      height *= resizeRatio;
      resize = true;
    }
    if (resize) {
      buffer = await sharp(buffer).resize({
        width: Math.round(width),
        height: Math.round(height)
      }).toBuffer();
    }
    return buffer;
  }
  /**
   * Checks if we are responsible to answer to this message.
   * We do only respond to messages which are posted in a thread or addressed to the bot. We also do not respond to
   * message which were posted by the bot.
   * @param msgData The parsed message data
   * @param meId The mattermost client id
   * @param previousPosts Older posts in the same channel
   */
  // メッセージが無視されるべきかどうかを判定する
  async isMessageIgnored(msgData, previousPosts) {
    if (msgData.post.user_id === this.meId) {
      return true;
    }
    const channelId = msgData.post.channel_id;
    const channel = await this.mattermostClient.getClient().getChannel(channelId);
    const members = await this.mattermostClient.getClient().getChannelMembers(channelId);
    if (channel.type === "D" && msgData.post.root_id === "" && members.length === 2 && members.find((member) => member.user_id === this.meId)) {
      return false;
    } else {
      if (msgData.post.root_id === "" && !msgData.mentions.includes(this.meId)) {
        return true;
      }
    }
    for (let i = previousPosts.length - 1; i >= 0; i--) {
      if (previousPosts[i].props.bot_status === "stopped") {
        return true;
      }
      if (previousPosts[i].user_id === this.meId || previousPosts[i].message.includes(this.name)) {
        return false;
      }
    }
    return true;
  }
  /**
   * 画像を使用しないかどうかを判定します。
   *
   * @param meId - 自分のユーザーID。
   * @param previousPosts - 過去の投稿の配列。
   * @returns 画像を使用しない場合はtrue、使用する場合はfalse。
   */
  // 画像を使用しないかどうかを判定する
  async isUnuseImages(previousPosts) {
    for (let i = previousPosts.length - 1; i >= 0; i--) {
      const post = previousPosts[i];
      if (post.props.bot_images === "stopped") {
        return true;
      }
      if (post.user_id === this.meId || post.message.includes("@" + await this.userIdToName(this.meId))) {
        return false;
      }
    }
    return false;
  }
  /**
   * Transforms a data object of a WebSocketMessage to a JS Object.
   * @param msg The WebSocketMessage data.
   */
  // メッセージデータを解析する
  parseMessageData(msg) {
    return {
      mentions: JSON.parse(msg.mentions ?? "[]"),
      // MattermostがちまよっていたらJSON.parseで例外でるかもしれない
      post: JSON.parse(msg.post),
      sender_name: msg.sender_name
    };
  }
  /**
   * Looks up posts which where created in the same thread and within a given timespan before the reference post.
   * @param refPost The reference post which determines the thread and start point from where older posts are collected.
   * @param options Additional arguments given as object.
   * <ul>
   *     <li><b>lookBackTime</b>: The look back time in milliseconds. Posts which were not created within this time before the
   *     creation time of the reference posts will not be collected anymore.</li>
   *     <li><b>postCount</b>: Determines how many of the previous posts should be collected. If this parameter is omitted all posts are returned.</li>
   * </ul>
   */
  // 古い投稿を取得する
  async getOlderPosts(refPost, options) {
    const thread = await this.mattermostClient.getClient().getPostThread(
      refPost.id,
      true,
      false,
      true
      /*関連するユーザを取得*/
    );
    let posts = [...new Set(thread.order)].map((id) => thread.posts[id]).filter((a) => !a.message.startsWith(SYSTEM_MESSAGE_HEADER)).map((post) => {
      post.message = post.message.replace(new RegExp(`^${SYSTEM_MESSAGE_HEADER}.+$`, "m"), "");
      return post;
    }).sort((a, b) => a.create_at - b.create_at);
    if (options.lookBackTime && options.lookBackTime > 0) {
      posts = posts.filter((a) => a.create_at > refPost.create_at - options.lookBackTime);
    }
    if (options.postCount && options.postCount > 0) {
      posts = posts.slice(-options.postCount);
    }
    return posts;
  }
  usernameCache = {};
  /**
   * Looks up the mattermost username for the given userId. Every username which is looked up will be cached for 5 minutes.
   * @param userId
   */
  // ユーザーIDからユーザー名を取得する
  async userIdToName(userId) {
    let username;
    if (this.usernameCache[userId] && Date.now() < this.usernameCache[userId].expireTime) {
      username = this.usernameCache[userId].username;
    } else {
      username = (await this.mattermostClient.getClient().getUser(userId)).username;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
        username = username.replace(/[.@!?]/g, "_").slice(0, 64);
      }
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
        username = [...username.matchAll(/[a-zA-Z0-9_-]/g)].join("").slice(0, 64);
      }
      this.usernameCache[userId] = {
        username,
        expireTime: Date.now() + 1e3 * 60 * 5
      };
    }
    return username;
  }
};

// src/MattermostClient.ts
import Mattermost from "@mattermost/client";
import { WebSocket } from "ws";
import fetch3 from "node-fetch";
if (!global.WebSocket) {
  global.WebSocket = WebSocket;
}
global.fetch = fetch3;
var MattermostClient = class _MattermostClient {
  client;
  wsClient;
  constructor(matterMostURLString, mattermostToken, botConfig) {
    if (!matterMostURLString) {
      botLog.error("MATTERMOST_URL is undefined", _MattermostClient.sanitizeConfig(botConfig));
      throw new Error("MATTERMOST_URL is undefined");
    }
    if (!mattermostToken) {
      botLog.error("MATTERMOST_TOKEN is undefined", matterMostURLString, _MattermostClient.sanitizeConfig(botConfig));
      throw new Error("MATTERMOST_TOKEN is undefined");
    }
    botLog.trace("Configuring Mattermost URL to " + matterMostURLString);
    this.client = new Mattermost.Client4();
    this.client.setUrl(matterMostURLString);
    this.client.setToken(mattermostToken);
    this.wsClient = new Mattermost.WebSocketClient();
    const wsUrl = new URL(this.client.getWebSocketUrl());
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss" : "ws";
    new Promise((_resolve, reject) => {
      this.wsClient.addCloseListener(() => reject());
      this.wsClient.addErrorListener((e) => {
        reject(e);
      });
    }).then(() => {
      process.exit(0);
    }).catch((reason) => {
      botLog.error(reason);
      process.exit(-1);
    });
    this.workaroundWebsocketPackageLostIssue(this.wsClient);
    this.wsClient.initialize(wsUrl.toString(), mattermostToken);
  }
  static sanitizeConfig(config2) {
    if (!config2) {
      return void 0;
    }
    const sanitizedConfig = { ...config2 };
    if (sanitizedConfig.apiKey) {
      sanitizedConfig.apiKey = "****";
    }
    if (sanitizedConfig.visionKey) {
      sanitizedConfig.visionKey = "****";
    }
    if (sanitizedConfig.imageKey) {
      sanitizedConfig.imageKey = "****";
    }
    if (sanitizedConfig.mattermostToken) {
      sanitizedConfig.mattermostToken = "****";
    }
    return sanitizedConfig;
  }
  workaroundWebsocketPackageLostIssue(webSocketClient) {
    let messageCount = 100;
    const firstMessagesListener = (_e) => {
      if (messageCount-- < 1) {
        webSocketClient.removeMessageListener(firstMessagesListener);
      }
    };
    webSocketClient.addMessageListener(firstMessagesListener);
  }
  getClient() {
    return this.client;
  }
  getWsClient() {
    return this.wsClient;
  }
};

// src/MultiInstance.ts
var botServices = {};
async function main() {
  const config2 = getConfig();
  config2.bots = config2.bots || [{}];
  await Promise.all(
    // eslint-disable-next-line max-lines-per-function
    config2.bots.map(async (botConfig) => {
      const name = botConfig.name ?? process.env["MATTERMOST_BOTNAME"];
      if (botServices[name]) {
        botLog.error(
          `Duplicate bot name detected: ${name}. Ignoring this bot configuration.`,
          MattermostClient.sanitizeConfig(botConfig)
        );
        return;
      }
      if (!name) {
        botLog.error("No name. Ignore provider config", MattermostClient.sanitizeConfig(botConfig));
        return;
      }
      botConfig.name = name;
      if (!botConfig.type) {
        if (process.env["AZURE_OPENAI_API_KEY"] || botConfig.apiVersion || botConfig.instanceName || botConfig.deploymentName) {
          if (!botConfig.apiKey && process.env["AZURE_OPENAI_API_KEY"]) {
            botConfig.apiKey = process.env["AZURE_OPENAI_API_KEY"];
          }
          botConfig.type = "azure";
        } else if (process.env["OPENAI_API_KEY"]) {
          if (!botConfig.apiKey && process.env["OPENAI_API_KEY"]) {
            botConfig.apiKey = process.env["OPENAI_API_KEY"];
          }
          botConfig.type = "openai";
        } else if (process.env["GOOGLE_API_KEY"]) {
          if (!botConfig.apiKey && process.env["GOOGLE_API_KEY"]) {
            botConfig.apiKey = process.env["GOOGLE_API_KEY"];
          }
          botConfig.type = "google";
        } else if (process.env["COHERE_API_KEY"]) {
          if (!botConfig.apiKey && process.env["COHERE_API_KEY"]) {
            botConfig.apiKey = process.env["COHERE_API_KEY"];
          }
          botConfig.type = "cohere";
        } else if (process.env["ANTHROPIC_API_KEY"]) {
          if (!botConfig.apiKey && process.env["ANTHROPIC_API_KEY"]) {
            botConfig.apiKey = process.env["ANTHROPIC_API_KEY"];
          }
          botConfig.type = "anthropic";
        } else {
          botLog.error(`${name} No type. Ignore provider config`, MattermostClient.sanitizeConfig(botConfig));
          return;
        }
        botLog.warn(`${name} No type. Guessing type as ${botConfig.type}.`, MattermostClient.sanitizeConfig(botConfig));
      }
      botLog.log(`${name} Connected to Mattermost.`);
      botConfig.mattermostToken ??= process.env[`${name.toUpperCase()}_MATTERMOST_TOKEN`] ?? process.env[`${botConfig.type.toUpperCase()}_MATTERMOST_TOKEN`] ?? process.env["MATTERMOST_TOKEN"];
      botConfig.mattermostUrl ??= config2.MATTERMOST_URL ?? process.env["MATTERMOST_URL"];
      const mattermostClient = new MattermostClient(botConfig.mattermostUrl, botConfig.mattermostToken, botConfig);
      botLog.log(`${name} Start LLM wrapper.`);
      let openAIWrapper;
      try {
        openAIWrapper = new OpenAIWrapper(botConfig, mattermostClient);
      } catch (e) {
        botLog.error(`${name} Failed to create OpenAIWrapper. Ignore it.`, e);
        return;
      }
      botLog.log(`${name} Start BotService.`);
      const meId = (await mattermostClient.getClient().getMe()).id;
      const botService = new BotService2(
        mattermostClient,
        meId,
        name,
        openAIWrapper,
        botConfig.plugins ?? config2.PLUGINS ?? process.env["PLUGINS"] ?? "image-plugin graph-plugin"
      );
      mattermostClient.getWsClient().addMessageListener((e) => botService.onClientMessage(e));
      botLog.trace(`${name} Listening to MM messages...`);
      botServices[name] = botService;
    })
  );
  if (Object.keys(botServices).length === 0) {
    botLog.error("No bot is configured. Exiting...");
    process.exit(-1);
  }
  botLog.log("All bots started.", Object.keys(botServices));
}
main().catch((reason) => {
  botLog.error(reason);
  process.exit(-1);
});
