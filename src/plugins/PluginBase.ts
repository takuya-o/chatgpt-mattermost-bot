import { AiResponse, MattermostMessageData } from '../types.js'
import { botLog } from '../logging.js'

type PluginArgument = {
  type: string
  description: string
}

/**
 * A base class for plugins defining some default functionality.
 * @typeParam T - The type of the argument object which is passed to the runPlugin method.
 */
export abstract class PluginBase<T> {
  protected readonly log = botLog

  public constructor(
    public readonly key: string,
    public readonly description: string,
  ) {}

  readonly pluginArguments: Record<string, PluginArgument> = {}
  readonly requiredArguments: string[] = []

  abstract runPlugin(args: T, msgData: MattermostMessageData): Promise<AiResponse>
  setup(): boolean {
    return true
  }
  protected addPluginArgument(name: string, type: string, description: string, optional = false) {
    this.pluginArguments[name] = { type, description }
    if (!optional) {
      this.requiredArguments.push(name)
    }
  }
}
