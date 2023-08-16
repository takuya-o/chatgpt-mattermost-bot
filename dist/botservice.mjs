// src/botservice.ts
import "isomorphic-fetch";
import {
  ChatCompletionRequestMessageRoleEnum as ChatCompletionRequestMessageRoleEnum3
} from "openai";

// src/logging.ts
import { Log } from "debug-level";
Log.options({ json: true, colors: true });
Log.wrapConsole("bot-ws", { level4log: "INFO" });
var botLog = new Log("bot");
var openAILog = new Log("open-ai");
var matterMostLog = new Log("mattermost");

// src/openai-wrapper.ts
import {
  ChatCompletionResponseMessageRoleEnum,
  Configuration,
  OpenAIApi
} from "openai";
var apiKey = process.env["OPENAI_API_KEY"];
openAILog.trace({ apiKey });
var configuration = new Configuration({ apiKey });
var azureOpenAiApiKey = process.env["AZURE_OPENAI_API_KEY"];
if (azureOpenAiApiKey) {
  configuration.baseOptions = {
    headers: { "api-key": azureOpenAiApiKey },
    params: {
      "api-version": process.env["AZURE_OPENAI_API_VERSION"] ?? "2023-07-01-preview"
    }
  };
  configuration.basePath = "https://" + process.env["AZURE_OPENAI_API_INSTANCE_NAME"] + ".openai.azure.com/openai/deployments/" + process.env["AZURE_OPENAI_API_DEPLOYMENT_NAME"];
}
var openai = new OpenAIApi(configuration);
var openaiImage;
if (azureOpenAiApiKey) {
  const configuration2 = new Configuration({ apiKey });
  if (!apiKey) {
    configuration2.baseOptions = {
      headers: { "api-key": azureOpenAiApiKey },
      params: {
        "api-version": process.env["AZURE_OPENAI_API_VERSION"] ?? "2023-07-01-preview"
      }
    };
    configuration2.basePath = "https://" + process.env["AZURE_OPENAI_API_INSTANCE_NAME"] + ".openai.azure.com/openai";
  }
  openaiImage = new OpenAIApi(configuration2);
}
var model = process.env["OPENAI_MODEL_NAME"] ?? "gpt-3.5-turbo";
var MAX_TOKENS = Number(process.env["OPENAI_MAX_TOKENS"] ?? 2e3);
var temperature = Number(process.env["OPENAI_TEMPERATURE"] ?? 1);
openAILog.debug({ model, max_tokens: MAX_TOKENS, temperature });
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
  let aiResponse = {
    message: "Sorry, but it seems I found no valid response.",
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
  let maxChainLength = 7;
  const missingPlugins = /* @__PURE__ */ new Set();
  let isIntermediateResponse = true;
  while (isIntermediateResponse && maxChainLength-- > 0) {
    const { responseMessage, usage } = await createChatCompletion(messages, functions);
    openAILog.trace(responseMessage);
    if (responseMessage) {
      if (usage && aiResponse.usage) {
        aiResponse.usage.prompt_tokens += usage.prompt_tokens;
        aiResponse.usage.completion_tokens += usage.completion_tokens;
        aiResponse.usage.total_tokens += usage.total_tokens;
      }
      if (responseMessage.function_call && responseMessage.function_call.name) {
        const pluginName = responseMessage.function_call.name;
        openAILog.trace({ pluginName });
        try {
          const plugin = plugins.get(pluginName);
          if (plugin) {
            const pluginArguments = JSON.parse(responseMessage.function_call.arguments ?? "[]");
            openAILog.trace({ plugin, pluginArguments });
            const pluginResponse = await plugin.runPlugin(pluginArguments, msgData);
            openAILog.trace({ pluginResponse });
            if (pluginResponse.intermediate) {
              messages.push({
                role: ChatCompletionResponseMessageRoleEnum.Function,
                name: pluginName,
                content: pluginResponse.message
              });
              continue;
            }
            aiResponse = pluginResponse;
          } else {
            if (!missingPlugins.has(pluginName)) {
              missingPlugins.add(pluginName);
              openAILog.debug({
                error: "Missing plugin " + pluginName,
                pluginArguments: responseMessage.function_call.arguments
              });
              messages.push({
                role: "system",
                content: `There is no plugin named '${pluginName}' available. Try without using that plugin.`
              });
              continue;
            } else {
              openAILog.debug({ messages });
              aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`;
            }
          }
        } catch (e) {
          openAILog.debug({ messages, error: e });
          aiResponse.message = `Sorry, but it seems there was an error when using the plugin \`\`\`${pluginName}\`\`\`.`;
        }
      } else if (responseMessage.content) {
        aiResponse.message = responseMessage.content;
      }
    }
    isIntermediateResponse = false;
  }
  return aiResponse;
}
async function createChatCompletion(messages, functions2 = void 0) {
  const chatCompletionOptions = {
    model,
    messages,
    max_tokens: MAX_TOKENS,
    temperature
  };
  if (functions2) {
    chatCompletionOptions.functions = functions2;
    chatCompletionOptions.function_call = "auto";
  }
  openAILog.trace({ chatCompletionOptions });
  const chatCompletion = await openai.createChatCompletion(chatCompletionOptions);
  openAILog.trace({ chatCompletion });
  return { responseMessage: chatCompletion.data?.choices?.[0]?.message, usage: chatCompletion.data?.usage };
}
async function createImage(prompt) {
  const createImageOptions = {
    prompt,
    n: 1,
    size: "512x512",
    response_format: "b64_json"
  };
  openAILog.trace({ createImageOptions });
  const image = await (openaiImage ? openaiImage : openai).createImage(createImageOptions);
  openAILog.trace({ image });
  return image.data?.data[0]?.b64_json;
}

// src/mm-client.ts
import { WebSocket } from "ws";
import fetch from "node-fetch";
import pkg from "@mattermost/client";
var { Client4, WebSocketClient } = pkg;
if (!global.WebSocket) {
  global.WebSocket = WebSocket;
}
global.fetch = fetch;
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
import { ChatCompletionRequestMessageRoleEnum } from "openai";
import FormData from "form-data";
import fetch2 from "node-fetch";
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
        role: ChatCompletionRequestMessageRoleEnum.System,
        content: this.VISUALIZE_DIAGRAM_INSTRUCTIONS
      },
      {
        role: ChatCompletionRequestMessageRoleEnum.User,
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
import { ChatCompletionRequestMessageRoleEnum as ChatCompletionRequestMessageRoleEnum2 } from "openai";
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
    }
    return aiResponse;
  }
  async createImagePrompt(userInput) {
    const messages = [
      {
        role: ChatCompletionRequestMessageRoleEnum2.System,
        content: this.GPT_INSTRUCTIONS
      },
      {
        role: ChatCompletionRequestMessageRoleEnum2.User,
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

// src/tokenCount.ts
import tiktoken from "tiktoken-node";
var enc = tiktoken.encodingForModel("gpt-3.5-turbo");
function tokenCount(content) {
  if (!content)
    return 0;
  const tokens = enc.encode(content);
  return tokens.length;
}

// src/botservice.ts
if (!global.FormData) {
  global.FormData = FormData3;
}
var name = process.env["MATTERMOST_BOTNAME"] || "@chatgpt";
var contextMsgCount = Number(process.env["BOT_CONTEXT_MSG"] ?? 100);
var SYSTEM_MESSAGE_HEADER = "// BOT System Message: ";
var LIMIT_TOKENS = Number(process.env["MAX_PROMPT_TOKENS"] ?? 2e3);
var plugins2 = [
  new GraphPlugin("graph-plugin", "Generate a graph based on a given description or topic"),
  new ImagePlugin("image-plugin", "Generates an image based on a given image description."),
  new ExitPlugin("exit-plugin", "Says goodbye to the user and wish him a good day."),
  new MessageCollectPlugin("message-collect-plugin", "Collects messages in the thread for a specific user or time")
];
var botInstructions = "Your name is " + name + " and you are a helpful assistant. Whenever users asks you for help you will provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the meta data of the messages.";
async function onClientMessage(msg, meId) {
  if (msg.event !== "posted" || !meId) {
    matterMostLog.debug({ msg });
    return;
  }
  const msgData = parseMessageData(msg.data);
  const posts = await getOlderPosts(msgData.post, { lookBackTime: 1e3 * 60 * 60 * 24 * 7 });
  if (isMessageIgnored(msgData, meId, posts)) {
    return;
  }
  const chatmessages = [
    {
      role: ChatCompletionRequestMessageRoleEnum3.System,
      content: botInstructions
    }
  ];
  for (const threadPost of posts.slice(-contextMsgCount)) {
    matterMostLog.trace({ msg: threadPost });
    if (threadPost.user_id === meId) {
      chatmessages.push({
        role: ChatCompletionRequestMessageRoleEnum3.Assistant,
        content: threadPost.props.originalMessage ?? threadPost.message
      });
    } else {
      chatmessages.push({
        role: ChatCompletionRequestMessageRoleEnum3.User,
        name: await userIdToName(threadPost.user_id),
        content: threadPost.message
      });
    }
  }
  await postMessage(msgData, chatmessages);
}
async function postMessage(msgData, messages) {
  const typing = () => wsClient.userTyping(msgData.post.channel_id, (msgData.post.root_id || msgData.post.id) ?? "");
  typing();
  const typingInterval = setInterval(typing, 2e3);
  let answer = "";
  let { sumMessagesCount, messagesCount } = calcMessagesTokenCount(messages);
  try {
    botLog.trace({ chatmessages: messages });
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
        answer = await failSafeCheck(messages, answer, msgData.post);
      } catch (e) {
        if (e instanceof TypeError) {
          newPost(e.message, msgData.post, void 0, void 0);
          return;
        }
        throw e;
      }
      const lines = messages[1].content.split("\n");
      if (lines.length < 1) {
        botLog.error("No contents", messages[1].content);
        answer += "No contents.";
        newPost(SYSTEM_MESSAGE_HEADER + answer, msgData.post, void 0, void 0);
        return;
      }
      const linesCount = [];
      lines.forEach((line, i) => {
        if (line === "") {
          lines[i] = "\n";
          linesCount[i] = 1;
        } else {
          lines[i] += "\n";
          linesCount[i] = tokenCount(lines[i]);
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
          systemMessage2 += "Forget previous message.\n```\n" + currentMessages[1].content.split("\n").slice(0, 3).join("\n") + "...\n```\n";
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
        const { message: completion, usage, fileId, props } = await continueThread(currentMessages, msgData);
        answer += `*** No.${++partNo} ***
${completion}`;
        answer += makeUsageMessage(usage);
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
      const { message: completion, usage, fileId, props } = await continueThread(messages, msgData);
      answer += completion;
      answer += makeUsageMessage(usage);
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
  function makeUsageMessage(usage) {
    if (!usage)
      return "";
    return `
${SYSTEM_MESSAGE_HEADER}Prompt:${usage.prompt_tokens} Completion:${usage.completion_tokens} Total:${usage.total_tokens}`;
  }
}
async function newPost(answer, post, fileId, props) {
  botLog.trace({ answer });
  const newPost2 = await mmClient.createPost({
    message: answer,
    channel_id: post.channel_id,
    props,
    root_id: post.root_id || post.id,
    file_ids: fileId ? [fileId] : void 0
  });
  botLog.trace({ msg: newPost2 });
}
function expireMessages(messages, sumMessagesCount, messagesCount, systemMessage) {
  while (messages.length > 2 && sumMessagesCount >= LIMIT_TOKENS) {
    botLog.info("Remove message", messages[1]);
    systemMessage += `Forget old message.
~~~
${messages[1].content.split("\n").slice(0, 3).join("\n")}
...
~~~
`;
    sumMessagesCount -= messagesCount[1];
    messagesCount = [messagesCount[0], ...messagesCount.slice(2)];
    messages = [messages[0], ...messages.slice(2)];
  }
  return { messages, sumMessagesCount, messagesCount, systemMessage };
}
function calcMessagesTokenCount(messages) {
  let sumMessagesCount = 0;
  const messagesCount = new Array(messages.length);
  messages.forEach((message, i) => {
    messagesCount[i] = tokenCount(message.content);
    sumMessagesCount += messagesCount[i];
  });
  return { sumMessagesCount, messagesCount };
}
async function failSafeCheck(messages, answer, post) {
  if (messages[0].role !== "system") {
    botLog.error("Invalid message", messages[0]);
    answer += `Invalid message. Role: ${messages[0].role} 
~~~
${messages[0].content}
~~~
`;
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, void 0, void 0);
    throw new TypeError(answer);
  }
  if (messages[1].role !== "user") {
    botLog.error("Invalid message", messages[1]);
    answer += `Invalid message. Role: ${messages[1].role} 
~~~
${messages[1].content}
~~~
`;
    await newPost(SYSTEM_MESSAGE_HEADER + answer, post, void 0, void 0);
    throw new TypeError(answer);
  }
  return answer;
}
function isMessageIgnored(msgData, meId, previousPosts) {
  if (msgData.post.root_id === "" && !msgData.mentions.includes(meId)) {
    return true;
  }
  if (msgData.post.user_id === meId) {
    return true;
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
function parseMessageData(msg) {
  return {
    mentions: JSON.parse(msg.mentions ?? "[]"),
    post: JSON.parse(msg.post),
    sender_name: msg.sender_name
  };
}
async function getOlderPosts(refPost, options) {
  const thread = await mmClient.getPostThread(refPost.id, true, false, true);
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
