> **Note** 👀
> - Configuration methods have changed in version 3 for support multiple bots
> - After version 3.1 have backward compatibility for enviromnent variables configurations on single instance.
> - Recommend manually rewrite environment variables into `config.yaml` for multi instance.

## Enhanced from the [original yGuy/chatgpt-mattermost-bot](https://github.com/yGuy/chatgpt-mattermost-bot)

* Support for multiple bots in a single process. You no longer need to run multiple docker containers to use multiple LLMs.

  ![Screenshot of mattermost left panel.](./multiBotInstance.png )
* Experimental support Cohere Command R+ that input is text only and Google Gemini 1.5 Pro API that can input text and image
* Support GPT-4V Vision API
  + Realization of multimodal text and images in conjunction with image plugins.

    **Limitation**: The plugins are not possible in threads that have been image attached, Under the gpt-4-vision-preview 1106.
  ![The screenshot depicts a fictional chat in Mattermost where a user asks a bot to describe a zoo scene, and to create an image that evokes positive emotions; the bot responds with a colorful zoo illustration and a vivid sunset beach scene.](./mattermost-gpt4v.png)
* No mention required in Direct Message
* Support Azure OpenAI API
  + Use the original OpenAI for image generation even when using Azure OpenAI API
* Build enhancement (The original is now in TypeScript as well by version 2.0.)
  + Formatted by Prettier
  + Lint by eslint
  + Build by esbuild
  + SWC for debug
* Token-count-based conversation thread management (MessageCollectPlugin may interfere)
* Splitting message that are too long
* Support GitLab AutoDevOps by test dummy

# A ChatGPT-powered Chatbot for Mattermost

![A chat window in Mattermost showing the chat between the OpenAI bot and "yGuy"](./mattermost-chat.png)

The bot can talk to you like a regular mattermost user. It's like having ``chat.openai.com`` built collaboratively built into Mattermost!
But that's not all, you can also use it to generate images via Dall-E or diagram visualizations via a yFiles plugin!

Here's how to get the bot running - it's easy if you have a Docker host.

You need
 - the [Mattermost token](https://docs.mattermost.com/integrations/cloud-bot-accounts.html) for the bot user (`@chatgpt` by default)
 - the [OpenAI API key](https://platform.openai.com/account/api-keys)
 - a [Docker](https://www.docker.com/) server for continuously running the service, alternatively for testing, Node.js 16 is sufficient.

Andrew Zigler from Mattermost created a [YouTube Video](https://www.youtube.com/watch?v=Hx4Ex7YZZiA) that quickly guides you through the setup.

If you want to learn more about how this plugin came to live, [read the blog post at yWorks.com](https://www.yworks.com/blog/diagramming-with-chatgpt)!


## Configuration

These are the available options, you can set them in the `config.yaml` file.
The filename can be changed using the CONFIG_FILE environment variable.

**see:** `config-sample.yaml` and `.env-sample` 

### Example `config.yaml`
```yaml
# System default settings
MATTERMOST_URL: 'https://your-mattermost-url.example.com'
BOT_CONTEXT_MSG: 100
PLUGINS: image-plugin
OPENAI_MAX_TOKENS: 2000
OPENAI_TEMPERATURE: 1
MAX_PROMPT_TOKENS: 2000

bots:
  - name: '@OpenAI'
    mattermostUrl: 'https://your-mattermost-url.example.com'
    mattermostToken: 'your-mattermost-token'
    type: 'openai'
    apiKey: 'your-openai-api-key'
    apiBase: 'https://api.openai.com/v1'
    modelName: 'gpt-4o-mini'
    visionModelName: 'gpt-4v'
    imageModelName: 'dall-e-3'
    maxTokens: 16384
    temperature: 1
    maxPromptTokens: 123904
    plugins: 'image-plugin'
  - name: '@ChatGPT'
    mattermostUrl: 'https://your-mattermost-url.example.com'
    mattermostToken: 'your-mattermost-token'
    type: 'azure'
    apiKey: 'your-azure-openai-api-key'
    apiVersion: '2024-10-21'
    instanceName: 'your-azure-instance-name'
    deploymentName: 'gpt-4o-mini'
    visionKey: 'your-azure-openai-vision-key'
    visionInstanceName: 'your-azure-vision-instance-name'
    visionDeploymentName: 'gpt-4-vision-preview'
    imageKey: 'your-azure-openai-image-key'
    imageInstanceName: 'your-azure-image-instance-name'
    imageDeploymentName: 'dall-e-3'
    maxTokens: 16384
    temperature: 1
    maxPromptTokens: 123904
    plugins: 'image-plugin'
  - name: '@Gemini'
    mattermostUrl: 'https://your-mattermost-url.example.com'
    mattermostToken: 'your-mattermost-token'
    type: 'google'
    apiKey: 'your-google-api-key'
    imageModelName: 'dall-e-3'
    maxTokens: 8192
    temperature: 1
    maxPromptTokens: 1048576
    plugins: ''
  - name: '@Cohere'
    mattermostUrl: 'https://your-mattermost-url.example.com'
    mattermostToken: 'your-mattermost-token'
    type: 'cohere'
    apiKey: 'your-cohere-api-key'
    imageModelName: 'dall-e-3'
    maxTokens: 4000
    temperature: 1
    maxPromptTokens: 123904
    plugins: ''
  - name: '@Anthropic'
    mattermostUrl: 'https://your-mattermost-url.example.com'
    mattermostToken: 'your-mattermost-token'
    type: 'anthropic'
    apiKey: 'your-anthropic-api-key'
    imageModelName: 'dall-e-3'
    maxTokens: 4096
    temperature: 1
    maxPromptTokens: 123904
    plugins: ''

# Bot instructions
BOT_INSTRUCTION: "You are a helpful assistant. Whenever users asks you for help you will provide them with succinct answers formatted using Markdown. You know the user's name as it is provided within the meta data of the messages."
```

### Configuration Options

| Name                 | Required | Default Value | Description                                                                                                           | Environment Variables                   |
|----------------------|----------|---------------|-----------------------------------------------------------------------------------------------------------------------|-----------------------------------------|
| MATTERMOST_URL       | yes      | none          | The URL to the Mattermost server. This is default for all bots.                                                       | MATTERMOST_URL                          |
| BOT_CONTEXT_MSG      | no       | 100           | The number of previous messages which are appended to the conversation with ChatGPT.                                  | BOT_CONTEXT_MSG                         |
| PLUGINS              | no       | 'image-plugin graph-plugin' | The enabled plugins of the bot. This is default for all bots. By default, all bot (graph-plugin and image-plugin) are enabled. | PLUGINS          |
| OPENAI_MAX_TOKENS    | no       | 2000          | The maximum number of tokens to pass to the LLM's API. This is default for all bots.                                  | OPENAI_MAX_TOKENS                       |
| OPENAI_TEMPERATURE   | no       | 1             | The sampling temperature to use, between 0 and 2. Higher values make the output more random, while lower values make it more focused and deterministic. This is default for all bots. | OPENAI_TEMPERATURE    |
| MAX_PROMPT_TOKENS    | no       | 2000          | Maximum number of prompt tokens. This is default for all bots.                                                        | MAX_PROMPT_TOKENS                       |
| BOT_INSTRUCTION      | no       | 'You are a helpful assistant...` | Extra instruction to give your assistance. How should the assistant behave? This setting used by all bots.       | BOT_INSTRUCTION           |
| **Individual bot settings** |||||
| name                 | yes      | none          | The name of the bot.                                                                                                  |                                         |
| mattermostUrl        | no       | none          | The URL to the Mattermost server for the bot.                                                                         | MATTERMOST_URL                          |
| mattermostToken      | yes      | none          | The authentication token for the Mattermost bot.                                                                      | \${name}_MATTERMOST_TOKEN, \${type}_MATTERMOST_TOKEN, MATTERMOST_TOKEN |
| type                 | yes      | none          | The type of AI provider (e.g., openai, azure, google, cohere, anthropic).                                             |                                         |
| apiKey               | yes      | none          | The API key for the AI provider.                                                                                      | OPENAI_API_KEY, AZURE_OPENAI_API_KEY, GOOGLE_API_KEY, COHERE_API_KEY, ANTHROPIC_API_KEY |
| apiBase              | no       | none          | The base URL for the AI provider's API.                                                                               | OPENAI_API_BASE                         |
| modelName            | no       | 'gpt-4o-mini' | The name of the model to use for chat completions.                                                                    | OPENAI_MODEL_NAME                       |
| visionModelName      | no       | none          | The name of the model to use for vision tasks.                                                                        |                                         |
| imageModelName       | no       | none          | The name of the model to use for image generation.                                                                    |                                         |
| apiVersion           | no       | '2024-10-21'  | The API version to use for the AI provider.                                                                           | AZURE_OPENAI_API_VERSION                |
| instanceName         | no       | none          | The instance name for the AI provider (specific to Azure).                                                            | AZURE_OPENAI_API_INSTANCE_NAME          |
| deploymentName       | no       | none          | The deployment name for the AI provider (specific to Azure).                                                          | AZURE_OPENAI_API_DEPLOYMENT_NAME        |
| visionKey            | no       | none          | The API key for the vision tasks (specific to Azure).                                                                 | AZURE_OPENAI_API_VISION_KEY             |
| visionInstanceName   | no       | none          | The instance name for the vision tasks (specific to Azure).                                                           | AZURE_OPENAI_API_VISION_INSTANCE_NAME   |
| visionDeploymentName | no       | none          | The deployment name for the vision tasks (specific to Azure).                                                         | AZURE_OPENAI_API_VISION_DEPLOYMENT_NAME |
| imageKey             | no       | none          | The API key for the image generation tasks (specific to Azure).                                                       | AZURE_OPENAI_API_IMAGE_KEY              |
| imageInstanceName    | no       | none          | The instance name for the image generation tasks (specific to Azure).                                                 | AZURE_OPENAI_API_IMAGE_INSTANCE_NAME    |
| imageDeploymentName  | no       | none          | The deployment name for the image generation tasks (specific to Azure).                                               | AZURE_OPENAI_API_IMAGE_DEPLOYMENT_NAME  |
| maxTokens            | no       | 2000          | The maximum number of tokens for the AI provider.                                                                     | OPENAI_MAX_TOKENS                       |
| temperature          | no       | 1             | The sampling temperature for the AI provider.                                                                         | OPENAI_TEMPERATURE                      |
| maxPromptTokens      | no       | 2000          | The maximum number of prompt tokens for the AI provider.                                                              | MAX_PROMPT_TOKENS                       |
| plugins              | no       | 'image-plugin graph-plugin' | The enabled plugins for the bot.  By default, The bot graph-plugin and image-plugin are enabled.        | PLUGINS                                 |

> **Note**
> The `YFILES_SERVER_URL` is used for automatically converting text information created by the bot into diagrams.
> This is currently in development. You can see it in action, here:
> [LinkedIn Post](https://www.linkedin.com/posts/yguy_chatgpt-yfiles-diagramming-activity-7046713027005407232-2bKH)
> If you are interested in getting your hands on the plugin, please contact [yWorks](https://www.yworks.com)!

## Using the ready-made Docker image

Use the prebuilt image from [`gitlab.on-o.com/docker/chatgpt-mattermost-bot/release`](https://gitlab.on-o.com/Docker/chatgpt-mattermost-bot/container_registry/150)

```bash
docker run -d --restart unless-stopped \
  -v /path/to/config.yaml:/app/config.yaml \
  --name chatbot \
  gitlab.on-o.com/docker/chatgpt-mattermost-bot/release:latest
```

## Building the Docker image manually

First step is to clone this repo.

```bash
git clone https://github.com/takuya-o/chatgpt-mattermost-bot.git && cd chatgpt-mattermost-bot
```

For testing, you could now just run `npm ci` and `npm run start` or directly, but be sure to set the [environment variables](#options) or pass them to the node process, first!

For production use, in order to create a service on a docker container that will always provide the service without you having to run it on your own machine, you can do the following:

Build the docker image from the [Dockerfile](./Dockerfile):
```bash
docker build . -t chatgpt-mattermost-bot
```

Create and run a container from the image
```bash
docker run -d --restart unless-stopped \
  -v /path/to/config.yaml:/app/config.yaml \
  --name chatbot \
  chatgpt-mattermost-bot
```

### Private TLS Certificate
If your Mattermost instance uses a TLS certificate signed by a private CA, you
will need to provide the CA's public root to the container for validation.

If the root certificate is located at `/absolutepath/to/certfile.crt`, then you
can mount that file into the container at a fixed position and specify the [node environment variable](https://nodejs.org/api/cli.html#node_extra_ca_certsfile) accordingly:
```bash
docker run -d --restart unless-stopped \
  -v /absolutepath/to/certfile.crt:/certs/certfile.crt \
  -e NODE_EXTRA_CA_CERTS=/certs/certfile.crt \
  -v /path/to/config.yaml:/app/config.yaml \
  --name chatbot \
  chatgpt-mattermost-bot
```

Verify it's running
```bash
docker ps
```

Later, to stop the service
```bash
docker stop chatbot
```

## Docker Compose
If you want to run docker compose (maybe even merge it with your mattermost docker stack), you can use this
as a starting point: First adjust the environment variables in `.env` copy from `.env-sample`.

### Required Environment Variables and Configuration

No environment variables need to be set, but you must provide a `config.yaml` file.

### Optional Environment Variables
```sh
# Console logging output level, default = INFO
DEBUG_LEVEL=TRACE

# Node environment, default = production
NODE_ENV=production
```

### Private TLS Certificate
If your Mattermost instance uses a TLS certificate signed by a private CA, you
will need to provide the CA's public root to the container for validation.

If the root certificate is located at `/absolutepath/to/certfile.crt`, then you
would merge the contents below into the `compose.yaml` file:
```yaml
services:
  chatbot:
    volumes:
      - /absolutepath/to/certfile.crt:/certs/certfile.crt:ro
    environment:
      NODE_EXTRA_CA_CERTS: /certs/certfile.crt
```

### Run the container as a service
When all configuration is complete, build and start the container service.

Build docker image:
```bash
docker compose build
```

Start container:
```bash
docker compose up -d
```

Verify it's running:
```bash
docker compose ps
```

To stop the container:
```bash
docker compose down
```


## Deploy to Kubernetes with Helm
The chatgpt-mattermost-bot chart deploys a containerized chatgpt-mattermost-bot instance which will connect to a running mattermost container in the same Kubernetes cluster.  Chart uses 'mattermost-team-edition' and the 'mattermost' namespace by default.  Uses environment variables MATTERMOST_TOKEN and OPENAI_API_KEY. 
```bash
helm upgrade chatgpt-mattermost-bot ./helm/chatgpt-mattermost-bot \
  --create-namespace \
  --install \
  -n mattermost \
  -f ./helm/chatgpt-mattermost-bot/values.yaml \
  --set config.MATTERMOST_TOKEN="$MATTERMOST_TOKEN" \
  --set config.OPENAI_API_KEY="$OPENAI_API_KEY"
```

## Example Conversation

Here's an example chat that I just had with our bot:

>@yguy:
>>@chatgpt - please write a short introductory paragraph for the README in the GitHub repo that hosts the sources for you, the friendly Mattermost bot. Tell the readers that you enjoy working for the nice people at yWorks and that everybody should install a Mattermost chatbot into their Mattermost chat system to benefit from a nice and helpful assistant like you are. I will include this in the README on the GitHub repo, so make this an engaging text! Thanks!

>chatgpt (BOT):
>>Hello there! I'm @chatgpt, a friendly and reliable Mattermost bot designed to make your communication experience smoother and more efficient. I'm honored to be part of the team at yWorks, where I help employees get things done faster and with less hassle. With my advanced machine learning algorithms, I'm capable of understanding complex natural language queries and providing succinct and accurate responses in a matter of seconds. Whether you're a developer looking for information on your codebase or a manager seeking to streamline your team's workflows, I'm here to help. Installing a Mattermost chatbot like me is a must for any organization looking to boost its productivity and enjoy a more pleasant communication experience. So what are you waiting for? Let's chat!

I built this tool as a quick hack on a rainy Saturday afternoon, but we are using the bot in production in our Mattermost instance at our office at [yworks](https://www.yworks.com) and the bot has proved to be very helpful for many simple tasks. Give it a try and provide feedback if you like! It's really not very expensive: We had it running for about 30 users for two weeks and that cost us less than half a dollar for the ChatGPT service!

I will also accept helpful pull requests if you find an issue or have an idea for an improvement.

Last but not least, check out [yWorks](https://www.yworks.com)' fine diagramming SDKs for software developers [yFiles](https://yworks.com/yfiles) and our [free online graph and diagram editors](https://yworks.com/editors)!

This is under MIT license Copyright (c) 2023 Sebastian Mueller (yWorks) and Michael Haeglsperger (yWorks)
