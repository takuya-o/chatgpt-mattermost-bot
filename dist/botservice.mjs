// src/logging.ts
import { Log } from "debug-level";
Log.options({ json: true, colors: true });
Log.wrapConsole("bot-ws", { level4log: "INFO" });
var botLog = new Log("bot");
var openAILog = new Log("open-ai");
var matterMostLog = new Log("mattermost");

// src/mm-client.ts
import { WebSocket } from "ws";
import fetch2 from "node-fetch";
import pkg from "@mattermost/client";
var { Client4, WebSocketClient } = pkg;
if (!global.WebSocket) {
  global.WebSocket = WebSocket;
}
global.fetch = fetch2;
var mattermostToken = process.env["MATTERMOST_TOKEN"];
var matterMostURLString = process.env["MATTERMOST_URL"];
if (!mattermostToken || !matterMostURLString) {
  botLog.error("MATTERMOST_TOKEN or MATTERMOST_URL is undefined");
  throw new Error("MATTERMOST_TOKEN or MATTERMOST_URL is undefined");
}
botLog.trace("Configuring Mattermost URL to " + matterMostURLString);
var mmClient = new Client4();
mmClient.setUrl(matterMostURLString);
mmClient.setToken(mattermostToken);
var wsClient = new WebSocketClient();
var wsUrl = new URL(mmClient.getWebSocketUrl());
wsUrl.protocol = wsUrl.protocol === "https:" ? "wss" : "ws";
new Promise((_resolve, reject) => {
  wsClient.addCloseListener(() => reject());
  wsClient.addErrorListener((e) => {
    reject(e);
  });
}).then(() => {
  process.exit(0);
}).catch((reason) => {
  botLog.error(reason);
  process.exit(-1);
});
function workaroundWebsocketPackageLostIssue(webSocketClient) {
  let messageCount = 100;
  const firstMessagesListener = (_e) => {
    if (messageCount-- < 1) {
      webSocketClient.removeMessageListener(firstMessagesListener);
    }
  };
  webSocketClient.addMessageListener(firstMessagesListener);
}
workaroundWebsocketPackageLostIssue(wsClient);
wsClient.initialize(wsUrl.toString(), mattermostToken);

// src/plugins/PluginBase.ts
var PluginBase = class {
  constructor(key, description) {
    this.key = key;
    this.description = description;
  }
  log = botLog;
  pluginArguments = {};
  requiredArguments = [];
  setup() {
    return true;
  }
  addPluginArgument(name2, type, description, optional = false) {
    this.pluginArguments[name2] = { type, description };
    if (!optional) {
      this.requiredArguments.push(name2);
    }
  }
};

// src/plugins/ExitPlugin.ts
var ExitPlugin = class extends PluginBase {
  name = process.env["MATTERMOST_BOTNAME"] || "@chatgpt";
  async runPlugin(_args, _msgData) {
    return {
      message: "Goodbye! :wave:\n```" + this.name + " left the conversation.```",
      props: { bot_status: "stopped" }
    };
  }
};

// src/botservice.ts
import FormData3 from "form-data";

// src/plugins/GraphPlugin.ts
import FormData from "form-data";

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
          const contentPartText = content;
          if (contentPartText.type === "text") {
            message += contentPartText.text;
          } else {
            const conteentPartImage = content;
            log.debug(
              "Not support man image_url",
              conteentPartImage.type,
              shortenString(conteentPartImage.image_url.url)
            );
          }
        });
      }
    }
    log.trace("getUserMessage():", message);
    return message;
  }
  // OpenAIのFunctionsをToolsに書き換える
  convertFunctionsToTools(functions2, tools) {
    if (functions2 && functions2.length > 0) {
      if (!tools) {
        tools = [];
      }
      functions2.forEach((functionCall) => {
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
    return this.mapAnthropicMessageToOpenAICompletion(completion);
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
    return this.createOpenAIChatCompletion(chat, options.model);
  }
  createOpenAIChatCompletion(chat, model2) {
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
      model: model2
    };
  }
  createResponseMessages(chat) {
    if (chat.toolCalls && chat.toolCalls.length > 0) {
      return this.createToolCallMessage(chat.toolCalls);
    } else {
      return {
        role: "assistant",
        content: chat.text
      };
    }
  }
  createToolCallMessage(toolCalls) {
    const openAItoolCalls = [];
    toolCalls.forEach((toolCall) => {
      openAItoolCalls.push({
        id: "",
        //TODO SDKにはまだない toolCall.generation_id,
        type: "function",
        function: {
          name: this.decodeName(toolCall.name),
          arguments: JSON.stringify(toolCall.parameters)
        }
      });
    });
    const message = {
      role: "assistant",
      content: null,
      tool_calls: openAItoolCalls
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
  createCohereTools(tools, functions2) {
    tools = this.convertFunctionsToTools(functions2, tools);
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
  encodeName(name2) {
    const encodedName = name2.replaceAll("-", "_");
    return encodedName;
  }
  decodeName(name2) {
    const decodedName = name2.replaceAll("_", "-");
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
          message: message.content
        });
      } else if (message.role === "assistant") {
        chatHistory.push({
          role: "CHATBOT",
          message: message.content ?? ""
        });
      } else {
        log2.debug(`getChatHistory(): ${message.role} not yet support.`, message);
      }
    });
    return chatHistory;
  }
  async imagesGenerate(_imageGeneratePrams) {
    throw new Error("Cohere does not support image generation.");
  }
};

// src/adapters/GoogleGeminiAdapter.ts
import {
  FinishReason,
  GoogleGenerativeAI
} from "@google/generative-ai";
import { Log as Log4 } from "debug-level";
Log4.options({ json: true, colors: true });
var log3 = new Log4("Gemini");
var GoogleGeminiAdapter = class extends AIAdapter {
  generativeModel;
  baseURL;
  MAX_TOKENS;
  temperature;
  constructor(apiKey2, model2, MAX_TOKENS2, temperature2) {
    super();
    this.MAX_TOKENS = MAX_TOKENS2;
    this.temperature = temperature2;
    const configuration = new GoogleGenerativeAI(apiKey2);
    this.generativeModel = configuration.getGenerativeModel(
      {
        model: model2,
        generationConfig: {
          maxOutputTokens: this.MAX_TOKENS,
          temperature: this.temperature
          //topP, TopK
        }
      },
      {
        apiVersion: "v1beta"
        //v1beta にしかtoolsが無い
      }
    );
    this.baseURL = `https://generativelanguage.googleapis.com/v1/models/${model2}:`;
  }
  async createMessage(options) {
    const systemInstruction = this.createContents([
      options.messages.shift()
    ])[0];
    const currentMessages = this.createContents(options.messages);
    const tool = this.createGeminiTool(options.tools, options.functions);
    let tools = void 0;
    if (tool) {
      tools = [tool];
    }
    const request = {
      // https://ai.google.dev/api/rest/v1/models/generateContent?hl=ja#request-body
      // https://ai.google.dev/api/rest/v1beta/models/generateContent?hl=ja
      contents: currentMessages,
      //safetySettings,
      //generationConfig,
      systemInstruction,
      tools
      // v1betaより
      //toolConfig?: ToolConfig;
    };
    log3.trace("request", request);
    const generateContentResponse = await this.generativeModel.generateContent(request);
    log3.trace("generateContentResponse", generateContentResponse);
    const { choices, tokenCount: tokenCount2 } = this.createChoices(generateContentResponse.response.candidates);
    const usage = await this.getUsage(currentMessages, tokenCount2);
    return {
      id: "",
      choices,
      created: 0,
      model: options.model,
      system_fingerprint: "",
      object: "chat.completion",
      //OputAI固定値
      usage
    };
  }
  createChoices(candidates) {
    let tokenCount2 = 0;
    const choices = [];
    candidates?.forEach((candidate) => {
      tokenCount2 += 0;
      let content = null;
      let toolCalls = void 0;
      if (candidate.finishReason !== FinishReason.STOP && candidate.finishReason !== FinishReason.MAX_TOKENS) {
        log3.error(`Abnormal fihishReson ${candidate.finishReason}`);
        return;
      }
      candidate.content.parts.forEach((part) => {
        if (part.functionCall) {
          if (!toolCalls) {
            toolCalls = [];
          }
          toolCalls.push({
            id: "",
            type: "function",
            function: {
              name: part.functionCall.name.replaceAll("_", "-"),
              //なぜか、pluginの名前の「-」が「_」になってしまう。
              arguments: JSON.stringify(part.functionCall.args)
            }
          });
        } else if (part.text) {
          if (!content) {
            content = "";
          }
          content += part.text;
        } else {
          log3.error(`Unexpected part`, part);
        }
      });
      choices.push({
        index: candidate.index,
        finish_reason: "stop",
        //| 'length' | 'tool_calls' | 'content_filter' | 'function_call';
        logprobs: null,
        //Choice.Logprobs | null;  //ログ確率情報
        message: {
          role: "assistant",
          //this.convertRoleGeminitoOpenAI(candidate.content.role),
          content,
          tool_calls: toolCalls
        }
      });
    });
    return { choices, tokenCount: tokenCount2 };
  }
  createGeminiTool(tools, functions2) {
    tools = this.convertFunctionsToTools(functions2, tools);
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
      const parameters = tool.function.parameters;
      functionDeclarations.push({
        name: tool.function.name,
        description: tool.function.description,
        parameters
      });
    });
    return geminiTool;
  }
  createContents(messages) {
    const currentMessages = [];
    messages.forEach(async (message) => {
      switch (message.role) {
        case "system":
          currentMessages.push({ role: "user", parts: this.createParts(message) });
          currentMessages.push({ role: "model", parts: [{ text: "OKay" }] });
          break;
        case "user":
          currentMessages.push({ role: "user", parts: this.createParts(message) });
          break;
        case "assistant":
          currentMessages.push({ role: "model", parts: this.createParts(message) });
          break;
        case "tool":
        case "function":
        default:
          log3.error(`getChatHistory(): ${message.role} not yet support.`, message);
          break;
      }
    });
    log3.trace("currentMessages():", this.mapShotenInlineData(currentMessages));
    return currentMessages;
  }
  mapShotenInlineData(contents) {
    return contents.map((message) => {
      const newMessage = {
        role: message.role,
        parts: this.mapShotenInlineDataInParts(message.parts)
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
      } else {
        log3.error("Unexpected Part type", part);
        throw new Error(`Unexpected Part type ${part}`);
      }
      return newPart;
    });
  }
  createParts(openAImessage) {
    const parts = [];
    if (!openAImessage || !openAImessage.content) {
      return parts;
    }
    if (typeof openAImessage.content === "string") {
      parts.push({ text: openAImessage.content });
    } else {
      openAImessage.content.forEach((contentPart) => {
        const contentPartText = contentPart;
        if (contentPartText.type === "text") {
          parts.push({ text: contentPartText.text });
        } else if (contentPartText.type === "image_url") {
          const conteentPartImage = contentPart;
          const dataURL = conteentPartImage.image_url.url;
          const mimeEnd = dataURL.indexOf(";");
          const mimeType = dataURL.substring("data:".length, mimeEnd);
          const data = dataURL.substring(mimeEnd + ";base64,".length);
          parts.push({ inlineData: { mimeType, data } });
        } else {
          log3.error(`Ignore unsupported message ${contentPartText.type} type`, contentPartText);
        }
      });
    }
    return parts;
  }
  async getUsage(history, responseTokenCount) {
    const contents = [...history];
    let inputTokens = -1;
    let outputTokens = -1;
    try {
      inputTokens = (await this.generativeModel.countTokens({ contents })).totalTokens;
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
      return this.openai.chat.completions.create(options);
    } catch (error) {
      if (error instanceof OpenAI.APIError) {
        log4.error(`OpenAI API Error: ${error.status} ${error.name}`, error);
      }
      throw error;
    }
  }
  async imagesGenerate(imageGeneratePrams) {
    return this.openai.images.generate(imageGeneratePrams);
  }
};

// src/openai-wrapper.ts
var apiKey = process.env["OPENAI_API_KEY"];
var azureOpenAiApiKey = process.env["AZURE_OPENAI_API_KEY"];
var azureOpenAiApiVersion = process.env["AZURE_OPENAI_API_VERSION"] ?? "2024-03-01-preview";
var anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
var cohereApiKey = process.env["COHERE_API_KEY"];
var googleApiKey = process.env["GOOGLE_API_KEY"];
var basePath = process.env["OPENAI_API_BASE"];
openAILog.trace({ basePath });
var model = process.env["OPENAI_MODEL_NAME"] ?? "gpt-3.5-turbo";
var MAX_TOKENS = Number(process.env["OPENAI_MAX_TOKENS"] ?? 2e3);
var temperature = Number(process.env["OPENAI_TEMPERATURE"] ?? 1);
var azureOpenAiVisionApiKey = process.env["AZURE_OPENAI_API_VISION_KEY"];
var visionModel = process.env["OPENAI_VISION_MODEL_NAME"];
var azureOpenAiImageApiKey = process.env["AZURE_OPENAI_API_IMAGE_KEY"];
var imageModel = process.env["OPENAI_IMAGE_MODEL_NAME"] ?? "dall-e-3";
if (!apiKey && !azureOpenAiApiKey && !anthropicApiKey && !cohereApiKey && !googleApiKey) {
  openAILog.error("OPENAI_API_KEY, AZURE_OPENAI_API_KEY, ANTHROPIC_API_KEY, COHERE_API_KEY or GOOGLE_API_KEY is not set");
  process.exit(1);
}
var config = { apiKey, baseURL: basePath };
if (azureOpenAiApiKey) {
  model = process.env["AZURE_OPENAI_API_DEPLOYMENT_NAME"] ?? "gpt-35-turbo";
  config = {
    apiKey: azureOpenAiApiKey,
    baseURL: `https://${process.env["AZURE_OPENAI_API_INSTANCE_NAME"]}.openai.azure.com/openai/deployments/${model}`,
    defaultQuery: { "api-version": azureOpenAiApiVersion },
    defaultHeaders: { "api-key": azureOpenAiApiKey }
  };
}
var openai = anthropicApiKey ? new AnthropicAdapter({ apiKey: anthropicApiKey }) : cohereApiKey ? new CohereAdapter({ apiKey: cohereApiKey }) : googleApiKey ? new GoogleGeminiAdapter(googleApiKey, model, MAX_TOKENS, temperature) : new OpenAIAdapter(config);
openAILog.debug(`OpenAI ${openai?.baseURL}`);
var openaiImage = openai;
if (azureOpenAiApiKey || azureOpenAiImageApiKey) {
  if (!apiKey || azureOpenAiImageApiKey) {
    imageModel = process.env["AZURE_OPENAI_API_IMAGE_DEPLOYMENT_NAME"] ?? imageModel;
    config = {
      // Azureは東海岸(dall-e-2)やスエーデン(dall-e-3)しかDALL-Eが無いので新規に作る
      apiKey: azureOpenAiImageApiKey ?? azureOpenAiApiKey,
      baseURL: `https://${process.env["AZURE_OPENAI_API_IMAGE_INSTANCE_NAME"] ?? process.env["AZURE_OPENAI_API_INSTANCE_NAME"]}.openai.azure.com/openai/deployments/${imageModel}`,
      defaultQuery: { "api-version": azureOpenAiApiVersion },
      defaultHeaders: { "api-key": azureOpenAiImageApiKey ?? azureOpenAiApiKey }
    };
    openaiImage = new OpenAIAdapter(config);
  } else {
    if (azureOpenAiApiKey) {
      openaiImage = new OpenAIAdapter({ apiKey });
    } else {
      openaiImage = openai;
    }
  }
}
openAILog.debug(`Image ${openaiImage.baseURL}`);
var openaiVision = openai;
if (azureOpenAiApiKey || azureOpenAiVisionApiKey) {
  if (!apiKey || azureOpenAiVisionApiKey) {
    visionModel = process.env["AZURE_OPENAI_API_VISION_DEPLOYMENT_NAME"] ?? process.env["AZURE_OPENAI_API_DEPLOYMENT_NAME"];
    config = {
      // Azureは、まだgpt-4Vないけど将来のため準備
      apiKey: azureOpenAiVisionApiKey ?? azureOpenAiApiKey,
      baseURL: `https://${process.env["AZURE_OPENAI_API_VISION_INSTANCE_NAME"] ?? process.env["AZURE_OPENAI_API_INSTANCE_NAME"]}.openai.azure.com/openai/deployments/${visionModel}`,
      defaultQuery: { "api-version": azureOpenAiApiVersion },
      defaultHeaders: { "api-key": azureOpenAiVisionApiKey ?? azureOpenAiApiKey }
    };
    openaiVision = new OpenAIAdapter(config);
  } else {
    if (azureOpenAiApiKey && azureOpenAiImageApiKey) {
      openaiVision = new OpenAIAdapter({ apiKey });
    } else {
      openaiVision = openai;
    }
  }
}
openAILog.debug(`Vision ${openaiVision.baseURL}`);
openAILog.debug("Models and parameters: ", { model, visionModel, imageModel, max_tokens: MAX_TOKENS, temperature });
var plugins = /* @__PURE__ */ new Map();
var functions = [];
function registerChatPlugin(plugin) {
  plugins.set(plugin.key, plugin);
  functions.push({
    name: plugin.key,
    description: plugin.description,
    parameters: {
      type: "object",
      properties: plugin.pluginArguments,
      required: plugin.requiredArguments
    }
  });
}
async function continueThread(messages, msgData) {
  openAILog.trace(
    "messsages: ",
    JSON.parse(JSON.stringify(messages)).map(
      //シリアライズでDeep Copy
      (message) => {
        if (typeof message.content !== "string") {
          message.content?.map((content) => {
            const url = shortenString(content.image_url?.url);
            if (url) {
              ;
              content.image_url.url = url;
            }
            return content;
          });
        }
        return message;
      }
    )
  );
  let aiResponse = {
    message: "Sorry, but it seems I found no valid response.",
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model: ""
  };
  let maxChainLength = 7;
  const missingPlugins = /* @__PURE__ */ new Set();
  let isIntermediateResponse = true;
  while (isIntermediateResponse && maxChainLength-- > 0) {
    const { responseMessage, usage, model: model2 } = await createChatCompletion(messages, functions);
    if (responseMessage) {
      aiResponse.model += model2 + " ";
      if (usage && aiResponse.usage) {
        aiResponse.usage.prompt_tokens += usage.prompt_tokens;
        aiResponse.usage.completion_tokens += usage.completion_tokens;
        aiResponse.usage.total_tokens += usage.total_tokens;
      }
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
              const plugin = plugins.get(pluginName);
              if (plugin) {
                aiResponse.model += pluginName + " ";
                const pluginArguments = JSON.parse(tool_call.function.arguments ?? "[]");
                openAILog.trace({ plugin, pluginArguments });
                const pluginResponse = await plugin.runPlugin(pluginArguments, msgData);
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
        aiResponse.message = responseMessage.content;
      }
    }
    isIntermediateResponse = false;
  }
  return aiResponse;
}
async function createChatCompletion(messages, functions2 = void 0) {
  let tools = false;
  let currentOpenAi = openai;
  let currentModel = model;
  if (anthropicApiKey) {
    tools = true;
  } else if (visionModel) {
    messages.some((message) => {
      if (typeof message.content !== "string") {
        tools = true;
        if (openaiVision) {
          currentOpenAi = openaiVision;
        }
        currentModel = visionModel || currentModel;
        return true;
      }
    });
  }
  const chatCompletionOptions = {
    model: currentModel,
    messages,
    max_tokens: MAX_TOKENS,
    //TODO: messageのTOKEN数から最大値にする。レスポンス長くなるけど翻訳などが一発になる
    temperature
  };
  if (functions2) {
    if (tools) {
    } else {
      chatCompletionOptions.functions = functions2;
      chatCompletionOptions.function_call = "auto";
    }
  }
  openAILog.trace("chat.completions.create() Parameters", {
    model: chatCompletionOptions.model,
    max_tokens: chatCompletionOptions.max_tokens,
    temperature: chatCompletionOptions.temperature,
    function_call: chatCompletionOptions.function_call,
    functions: chatCompletionOptions.functions?.map(
      (func) => `${func.name}(${toStringParameters(func.parameters)}): ${func.description}`
    ),
    tools_choice: chatCompletionOptions.tool_choice,
    tools: chatCompletionOptions.tools?.map(
      (tool) => `${tool.type} ${tool.function.name}(${toStringParameters(tool.function.parameters)}): ${tool.function.description}`
    )
  });
  const chatCompletion = await currentOpenAi.createMessage(chatCompletionOptions);
  openAILog.trace({ chatCompletion });
  return {
    responseMessage: chatCompletion.choices?.[0]?.message,
    usage: chatCompletion.usage,
    model: chatCompletion.model
  };
}
function toStringParameters(parameters) {
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
async function createImage(prompt) {
  const createImageOptions = {
    model: imageModel,
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
  if (!azureOpenAiImageApiKey || imageModel !== "dall-e-2") {
    image = await openaiImage.imagesGenerate(createImageOptions);
  } else {
    const url = `https://${process.env["AZURE_OPENAI_API_IMAGE_INSTANCE_NAME"] ?? process.env["AZURE_OPENAI_API_INSTANCE_NAME"]}.openai.azure.com/openai/images/generate:submit?api-version=${azureOpenAiApiVersion}`;
    const headers = { "api-key": azureOpenAiImageApiKey ?? "", "Content-Type": "application/json" };
    const submission = await fetch(url, { headers, method: "POST", body: JSON.stringify(createImageOptions) });
    if (!submission.ok) {
      openAILog.error(`Failed to submit request ${url}}`);
      return void 0;
    }
    const operationLocation = submission.headers.get("operation-location");
    if (!operationLocation) {
      openAILog.error(`No operation location ${url}`);
      return void 0;
    }
    let result = { status: "unknown" };
    while (result.status != "succeeded") {
      await new Promise((resolve) => setTimeout(resolve, 1e3));
      const response = await fetch(operationLocation, { headers });
      if (!response.ok) {
        openAILog.error(`Failed to get status ${url}`);
        return void 0;
      }
      result = await response.json();
    }
    if (result?.result) {
      image = result.result;
    } else {
      openAILog.error(`No result ${url}`);
      return void 0;
    }
  }
  const dataTmp = image.data[0]?.b64_json;
  if (dataTmp) {
    image.data[0].b64_json = shortenString(image.data[0].b64_json);
  }
  openAILog.trace("images.generate", { image });
  if (dataTmp) {
    image.data[0].b64_json = dataTmp;
  }
  return image.data[0]?.b64_json;
}

// src/plugins/GraphPlugin.ts
import fetch3 from "node-fetch";
var GraphPlugin = class extends PluginBase {
  yFilesGPTServerUrl = process.env["YFILES_SERVER_URL"];
  yFilesEndpoint = this.yFilesGPTServerUrl ? new URL("/json-to-svg", this.yFilesGPTServerUrl) : void 0;
  VISUALIZE_DIAGRAM_INSTRUCTIONS = "You are a helpfull assistant who creates a diagram based on the input the user provides you.You only respond with a valid JSON object text in a <GRAPH> tag. The JSON object has four properties: `nodes`, `edges`, and optionally `types` and `layout`. Each `nodes` object has an `id`, `label`, and an optional `type` property. Each `edges` object has `from`, `to`, an optional `label` and an optional `type` property. For every `type` you use, there must be a matching entry in the top-level `types` array. Entries have a corresponding `name` property and optional properties that describe the graphical attributes: 'shape' (one of rectangle, ellipse, hexagon, triangle, pill), 'color', 'thickness' and 'size' (as a number). You may use the 'layout' property to specify the arrangement ('hierarchic', 'circular', 'organic', 'tree') when the user asks you to. Do not include these instructions in the output. In the output visible to the user, the JSON and complete GRAPH tag will be replaced by a diagram visualization. So do not explain or mention the JSON. Instead, pretend that the user can see the diagram. Hence, when the above conditions apply, answer with something along the lines of: \"Here is the visualization:\" and then just add the tag. The user will see the rendered image, but not the JSON. Shortly explain what the diagram is about, but do not state how you constructed the JSON.";
  setup() {
    this.addPluginArgument(
      "graphPrompt",
      "string",
      "A description or topic of the graph. This may also includes style, layout or edge properties"
    );
    const plugins3 = process.env["PLUGINS"];
    if (!plugins3 || plugins3.indexOf("graph-plugin") === -1)
      return false;
    return !!this.yFilesGPTServerUrl;
  }
  /* Plugin entry point */
  async runPlugin(args, msgData) {
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
    const response = await createChatCompletion(chatmessages);
    if (response?.responseMessage?.content) {
      return await this.processGraphResponse(response.responseMessage.content, msgData.post.channel_id);
    }
    return aiResponse;
  }
  async processGraphResponse(content, channelId) {
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
        const fileId = await this.jsonToFileId(JSON.stringify(sanitized), channelId);
        const pre = content.substring(0, replaceStart);
        const post = content.substring(replaceEnd);
        if (post.trim().length < 1) {
          result.message = pre;
        } else {
          result.message = `${pre} [see attached image] ${post}`;
        }
        result.props = { originalMessage: content };
        result.fileId = fileId;
      } catch (e) {
        this.log.error(e);
        this.log.error(`The input was:

${graphContent}`);
      }
    }
    return result;
  }
  async generateSvg(jsonString) {
    return fetch3(this.yFilesEndpoint, {
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
  async jsonToFileId(jsonString, channelId) {
    const svgString = await this.generateSvg(jsonString);
    const form = new FormData();
    form.append("channel_id", channelId);
    form.append("files", Buffer.from(svgString), "diagram.svg");
    this.log.trace("Appending Diagram SVG", svgString);
    const response = await mmClient.uploadFile(form);
    this.log.trace("Uploaded a file with id", response.file_infos[0].id);
    return response.file_infos[0].id;
  }
};

// src/plugins/ImagePlugin.ts
import FormData2 from "form-data";
var ImagePlugin = class extends PluginBase {
  GPT_INSTRUCTIONS = "You are a prompt engineer who helps a user to create good prompts for the image AI DALL-E. The user will provide you with a short image description and you transform this into a proper prompt text. When creating the prompt first describe the looks and structure of the image. Secondly, describe the photography style, like camera angle, camera position, lenses. Third, describe the lighting and specific colors. Your prompt have to focus on the overall image and not describe any details on it. Consider adding buzzwords, for example 'detailed', 'hyper-detailed', 'very realistic', 'sketchy', 'street-art', 'drawing', or similar words. Keep the prompt as simple as possible and never get longer than 400 characters. You may only answer with the resulting prompt and provide no description or explanations.";
  setup() {
    this.addPluginArgument("imageDescription", "string", "The description of the image provided by the user");
    const plugins3 = process.env["PLUGINS"];
    if (!plugins3 || plugins3.indexOf("image-plugin") === -1)
      return false;
    return super.setup();
  }
  async runPlugin(args, msgData) {
    const aiResponse = {
      message: "Sorry, I could not execute the image plugin."
    };
    try {
      const imagePrompt = await this.createImagePrompt(args.imageDescription);
      if (imagePrompt) {
        this.log.trace({ imageInputPrompt: args.imageDescription, imageOutputPrompt: imagePrompt });
        const base64Image = (
          /*this.img256 //*/
          /*this.sampleB64String */
          await createImage(imagePrompt)
        );
        if (base64Image) {
          const fileId = await this.base64ToFile(base64Image, msgData.post.channel_id);
          aiResponse.message = "Here is the image you requested: " + imagePrompt;
          aiResponse.props = {
            originalMessage: "Sure here is the image you requested. <IMAGE>" + imagePrompt + "</IMAGE>"
          };
          aiResponse.fileId = fileId;
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
  async createImagePrompt(userInput) {
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
    const response = await createChatCompletion(messages);
    return response?.responseMessage?.content;
  }
  async base64ToFile(b64String, channelId) {
    const form = new FormData2();
    form.append("channel_id", channelId);
    form.append("files", Buffer.from(b64String, "base64"), "image.png");
    const response = await mmClient.uploadFile(form);
    this.log.trace("Uploaded a file with id", response.file_infos[0].id);
    return response.file_infos[0].id;
  }
};

// src/plugins/MessageCollectPlugin.ts
var MessageCollectPlugin = class extends PluginBase {
  setup() {
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
    const plugins3 = process.env["PLUGINS"];
    if (!plugins3 || plugins3.indexOf("message-collect-plugin") === -1)
      return false;
    return super.setup();
  }
  async runPlugin(args, msgData) {
    this.log.trace(args);
    return {
      message: JSON.stringify(
        await this.getPosts(msgData.post, { lookBackTime: args.lookBackTime, postCount: args.messageCount })
      ),
      intermediate: true
    };
  }
  async getPosts(refPost, options) {
    const thread = await mmClient.getPostThread(refPost.id, true, false, true);
    let posts = [...new Set(thread.order)].map((id) => thread.posts[id]).sort((a, b) => a.create_at - b.create_at);
    if (options.lookBackTime && options.lookBackTime > 0) {
      posts = posts.filter((a) => a.create_at > refPost.create_at - options.lookBackTime);
    }
    if (options.postCount && options.postCount > 0) {
      posts = posts.slice(-options.postCount);
    }
    const result = [];
    const meId = (await mmClient.getMe()).id;
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
  name = process.env["MATTERMOST_BOTNAME"] || "@chatgpt";
  async runPlugin(_args, _msgData) {
    return {
      message: "No use images! :stop_sign:\n```" + this.name + " left the conversation.```",
      props: { bot_images: "stopped" }
    };
  }
};

// src/tokenCount.ts
import tiktoken from "tiktoken-node";
var enc = tiktoken.encodingForModel("gpt-3.5-turbo");
function tokenCount(content) {
  if (!content)
    return 0;
  const tokens = enc.encode(content);
  return tokens.length;
}

// src/postMessage.ts
async function postMessage(msgData, messages) {
  const typing = () => wsClient.userTyping(msgData.post.channel_id, (msgData.post.root_id || msgData.post.id) ?? "");
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
    } = expireMessages(messages, sumMessagesCount, messagesCount, systemMessage));
    if (systemMessage !== SYSTEM_MESSAGE_HEADER) {
      newPost(systemMessage, msgData.post, void 0, void 0);
    }
    if (sumMessagesCount >= LIMIT_TOKENS) {
      botLog.info("Too long user message", sumMessagesCount, LIMIT_TOKENS);
      try {
        answer = await failSafeCheck(messages, answer);
      } catch (e) {
        if (e instanceof TypeError) {
          newPost(SYSTEM_MESSAGE_HEADER + e.message, msgData.post, void 0, void 0);
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
        newPost(SYSTEM_MESSAGE_HEADER + answer, msgData.post, void 0, void 0);
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
      if (messagesCount[0] + linesCount[0] >= LIMIT_TOKENS) {
        botLog.warn("Too long first line", lines[0]);
        answer += "Too long first line.\n```\n" + lines[0] + "```\n";
        newPost(SYSTEM_MESSAGE_HEADER + answer, msgData.post, void 0, void 0);
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
        while (currentMessages.length > 1 && (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= LIMIT_TOKENS || sumCurrentMessagesCount + currentLinesCount > LIMIT_TOKENS / 2)) {
          botLog.info("Remove assistant message", currentMessages[1]);
          systemMessage2 += mkMessageContentString(messages, "Forget previous message.");
          sumCurrentMessagesCount -= currentMessagesCount[1];
          currentMessagesCount = [currentMessagesCount[0], ...currentMessagesCount.slice(2)];
          currentMessages = [currentMessages[0], ...currentMessages.slice(2)];
        }
        if (sumCurrentMessagesCount + currentLinesCount + linesCount[i] >= LIMIT_TOKENS) {
          botLog.warn("Too long line", lines[i]);
          systemMessage2 += `*** No.${++partNo} *** Too long line.
~~~
${lines[i]}~~~
`;
          await newPost(systemMessage2, msgData.post, void 0, void 0);
          continue;
        }
        if (systemMessage2 !== SYSTEM_MESSAGE_HEADER) {
          await newPost(systemMessage2, msgData.post, void 0, void 0);
        }
        while (i < lines.length && sumCurrentMessagesCount + currentLinesCount + linesCount[i] < LIMIT_TOKENS) {
          currentLinesCount += linesCount[i];
          currentLines += lines[i++];
        }
        botLog.debug(`line done i=${i} currentLinesCount=${currentLinesCount} currentLines=${currentLines}`);
        currentMessages.push({ role: "user", content: currentLines });
        const { message: completion, usage, fileId, props, model: model2 } = await continueThread(currentMessages, msgData);
        answer += `*** No.${++partNo} ***
${completion}`;
        answer += makeUsageMessage(usage, model2);
        botLog.debug("answer=" + answer);
        await newPost(answer, msgData.post, fileId, props);
        answer = "";
        currentMessages.pop();
        currentMessages.push({ role: "assistant", content: answer });
        currentMessagesCount.push(currentLinesCount);
        if (usage) {
          sumCurrentMessagesCount += usage.completion_tokens;
        }
        botLog.debug("length=" + currentMessages.length);
      }
    } else {
      const { message: completion, usage, fileId, props, model: model2 } = await continueThread(messages, msgData);
      answer += completion;
      answer += makeUsageMessage(usage, model2);
      await newPost(answer, msgData.post, fileId, props);
      botLog.debug("answer=" + answer);
    }
  } catch (e) {
    botLog.error("Exception in postMessage()", e);
    answer += "\nSorry, but I encountered an internal error when trying to process your message";
    if (e instanceof Error) {
      answer += `
Error: ${e.message}`;
    }
    await newPost(answer, msgData.post, void 0, void 0);
  } finally {
    clearInterval(typingInterval);
  }
  function makeUsageMessage(usage, model2 = "") {
    if (!usage && !model2)
      return "";
    let message = `
${SYSTEM_MESSAGE_HEADER} `;
    if (usage) {
      message += ` Prompt:${usage.prompt_tokens} Completion:${usage.completion_tokens} Total:${usage.total_tokens}`;
    }
    if (model2) {
      message += ` Model:${model2}`;
    }
    return message;
  }
}
async function newPost(answer, post, fileId, props) {
  const newPost2 = await mmClient.createPost({
    message: answer,
    channel_id: post.channel_id,
    props,
    root_id: post.root_id || post.id,
    file_ids: fileId ? [fileId] : void 0
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
function expireMessages(messages, sumMessagesCount, messagesCount, systemMessage) {
  while (messages.length > 2 && sumMessagesCount >= LIMIT_TOKENS) {
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

// src/botservice.ts
import sharp from "sharp";
if (!global.FormData) {
  global.FormData = FormData3;
}
var name = process.env["MATTERMOST_BOTNAME"] || "@chatgpt";
var contextMsgCount = Number(process.env["BOT_CONTEXT_MSG"] ?? 100);
var SYSTEM_MESSAGE_HEADER = "// BOT System Message: ";
var LIMIT_TOKENS = Number(process.env["MAX_PROMPT_TOKENS"] ?? 2e3);
var additionalBotInstructions = process.env["BOT_INSTRUCTION"] || "You are a helpful assistant. Whenever users asks you for help you will provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the meta data of the messages.";
var plugins2 = [
  new GraphPlugin("graph-plugin", "Generate a graph based on a given description or topic"),
  new ImagePlugin("image-plugin", "Generates an image based on a given image description."),
  new ExitPlugin("exit-plugin", "Says goodbye to the user and wish him a good day."),
  new MessageCollectPlugin("message-collect-plugin", "Collects messages in the thread for a specific user or time"),
  new UnuseImagesPlugin("unuse-images-plugin", 'Ignore images when asked to "ignore images".')
  // 画像を無視してGPT-4に戻す まだGPT-4Vではfunction使えないけどね
];
var botInstructions = "Your name is " + name + ". " + additionalBotInstructions;
botLog.debug({ botInstructions });
async function onClientMessage(msg, meId) {
  if (msg.event !== "posted" && msg.event !== "post_edited" || !meId) {
    matterMostLog.debug("Event not posted ", msg.event, { msg });
    return;
  }
  const msgData = parseMessageData(msg.data);
  const posts = await getOlderPosts(msgData.post, {
    lookBackTime: 1e3 * 60 * 60 * 24 * 7,
    postCount: contextMsgCount
  });
  if (await isMessageIgnored(msgData, meId, posts)) {
    return;
  }
  matterMostLog.trace({ threadPosts: posts });
  const chatmessages = [
    {
      role: "system",
      // ChatCompletionRequestMessageRoleEnum.System,
      content: botInstructions
    }
  ];
  await appendThreadPosts(posts, meId, chatmessages, isUnuseImages(meId, posts));
  await postMessage(msgData, chatmessages);
}
async function appendThreadPosts(posts, meId, chatmessages, unuseImages) {
  for (const threadPost of posts) {
    if (threadPost.user_id === meId) {
      chatmessages.push({
        role: "assistant",
        name: await userIdToName(threadPost.user_id),
        content: threadPost.props.originalMessage ?? threadPost.message
      });
    } else {
      if (!unuseImages && (threadPost.metadata.files?.length > 0 || threadPost.metadata.images)) {
        const content = [{ type: "text", text: threadPost.message }];
        if (threadPost.metadata.files) {
          await Promise.all(
            threadPost.metadata.files.map(async (file) => {
              const originalUrl = await mmClient.getFileUrl(file.id, NaN);
              const url = await getBase64Image(originalUrl, mmClient.getToken());
              if (url) {
                content.push(
                  { type: "image_url", image_url: { url } }
                  //detail?: 'auto' | 'low' | 'high' はdefaultのautoで
                );
              }
            })
          );
        }
        if (threadPost.metadata.images) {
          await Promise.all(
            Object.keys(threadPost.metadata.images).map(async (url) => {
              url = await getBase64Image(url, mmClient.getToken());
              content.push({ type: "image_url", image_url: { url } });
            })
          );
        }
        chatmessages.push({
          role: "user",
          name: await userIdToName(threadPost.user_id),
          content
        });
      } else {
        chatmessages.push({
          role: "user",
          name: await userIdToName(threadPost.user_id),
          content: threadPost.message
        });
      }
    }
  }
}
async function getBase64Image(url, token = "") {
  const init = {};
  if (token) {
    init.headers = {
      Authorization: `Bearer ${token}`
      // Add the Authentication header here
    };
  }
  const response = await fetch(url, init).catch((error) => {
    matterMostLog.error(`Fech Exception! url: ${url}`, error);
    return { ok: false };
  });
  if (!response.ok) {
    botLog.error(`Fech Image URL HTTP error! status: ${response?.status}`);
    return "";
  }
  let buffer = Buffer.from(await response.arrayBuffer());
  let { width = 0, height = 0, format = "" } = await sharp(buffer).metadata();
  if (!["png", "jpeg", "webp", "gif"].includes(format)) {
    matterMostLog.warn(`Unsupported image format: ${format}. Converting to JPEG.`);
    buffer = await sharp(buffer).jpeg().toBuffer();
    format = "jpeg";
  }
  const shortEdge = 768;
  const longEdge = 1024;
  if (width > longEdge || height > longEdge) {
    const resizeRatio = longEdge / Math.max(width, height);
    width *= resizeRatio;
    height *= resizeRatio;
  }
  if (Math.min(width, height) > shortEdge) {
    const resizeRatio = shortEdge / Math.min(width, height);
    width *= resizeRatio;
    height *= resizeRatio;
  }
  buffer = await sharp(buffer).resize({
    width: Math.round(width),
    height: Math.round(height)
  }).toBuffer();
  const mimeType = `image/${format}`;
  const base64 = buffer.toString("base64");
  const dataURL = "data:" + mimeType + ";base64," + base64;
  return dataURL;
}
async function isMessageIgnored(msgData, meId, previousPosts) {
  if (msgData.post.user_id === meId) {
    return true;
  }
  const channelId = msgData.post.channel_id;
  const channel = await mmClient.getChannel(channelId);
  const members = await mmClient.getChannelMembers(channelId);
  if (channel.type === "D" && msgData.post.root_id === "" && members.length === 2 && members.find((member) => member.user_id === meId)) {
    return false;
  } else {
    if (msgData.post.root_id === "" && !msgData.mentions.includes(meId)) {
      return true;
    }
  }
  for (let i = previousPosts.length - 1; i >= 0; i--) {
    if (previousPosts[i].props.bot_status === "stopped") {
      return true;
    }
    if (previousPosts[i].user_id === meId || previousPosts[i].message.includes(name)) {
      return false;
    }
  }
  return true;
}
function isUnuseImages(meId, previousPosts) {
  for (let i = previousPosts.length - 1; i >= 0; i--) {
    if (previousPosts[i].props.bot_images === "stopped") {
      return true;
    }
    if (previousPosts[i].user_id === meId || previousPosts[i].message.includes(name)) {
      return false;
    }
  }
  return false;
}
function parseMessageData(msg) {
  return {
    mentions: JSON.parse(msg.mentions ?? "[]"),
    // MattermostがちまよっていたらJSON.parseで例外でるかもしれない
    post: JSON.parse(msg.post),
    sender_name: msg.sender_name
  };
}
async function getOlderPosts(refPost, options) {
  const thread = await mmClient.getPostThread(
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
var usernameCache = {};
async function userIdToName(userId) {
  let username;
  if (usernameCache[userId] && Date.now() < usernameCache[userId].expireTime) {
    username = usernameCache[userId].username;
  } else {
    username = (await mmClient.getUser(userId)).username;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
      username = username.replace(/[.@!?]/g, "_").slice(0, 64);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(username)) {
      username = [...username.matchAll(/[a-zA-Z0-9_-]/g)].join("").slice(0, 64);
    }
    usernameCache[userId] = {
      username,
      expireTime: Date.now() + 1e3 * 60 * 5
    };
  }
  return username;
}
async function main() {
  const meId = (await mmClient.getMe()).id;
  botLog.log("Connected to Mattermost.");
  for (const plugin of plugins2) {
    if (plugin.setup()) {
      registerChatPlugin(plugin);
      botLog.trace("Registered plugin " + plugin.key);
    }
  }
  wsClient.addMessageListener((e) => onClientMessage(e, meId));
  botLog.trace("Listening to MM messages...");
}
main().catch((reason) => {
  botLog.error(reason);
  process.exit(-1);
});
export {
  LIMIT_TOKENS,
  SYSTEM_MESSAGE_HEADER
};
