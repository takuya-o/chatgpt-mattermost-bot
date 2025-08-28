import { ConfigFile, ProviderConfig } from './types'
import fs from 'fs'
import yaml from 'js-yaml'

// 設定ファイルの読み込みとキャッシュを行うクラス
export class ConfigLoader {
  // configCacheの型をConfigFile | nullに変更
  private static instance: ConfigLoader
  private configCache: ConfigFile | null = null

  private constructor() {}

  // シングルトンインスタンスを取得
  static getInstance() {
    if (!ConfigLoader.instance) {
      ConfigLoader.instance = new ConfigLoader()
    }
    return ConfigLoader.instance
  }

  // 設定ファイルを取得（キャッシュあり）
  getConfig(): ConfigFile {
    if (this.configCache) {
      // キャッシュがあればそれを返す
      return this.configCache
    }
    const configFileName = process.env.CONFIG_FILE || './config.yaml'
    // ファイルが存在するか確認し、存在しない場合は空のConfigFileを返す
    if (!fs.existsSync(configFileName)) {
      this.configCache = {} as ConfigFile
      return this.configCache
    }
    const fileContents = fs.readFileSync(configFileName, 'utf8')
    // yaml.loadの型アサーションをConfigFileに変更
    const data = yaml.load(fileContents) as ConfigFile
    this.configCache = data
    return data
  }

  // AIプロバイダーの設定リストを取得
  getAIProvidersConfig() {
    const config = this.getConfig()
    // configにはbots以外の設定項目も含まれる
    const providers: ProviderConfig[] = (config.bots || []).map((bot: ProviderConfig) => ({
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
      verbosity: bot.verbosity,
    }))
    // 他の設定項目もconfigから参照可能
    // 例: config.server, config.logging など
    return providers
  }
}

// 既存の関数をクラス経由でエクスポート（既存利用箇所の互換性維持のため）
export function getConfig(): ConfigFile {
  return ConfigLoader.getInstance().getConfig()
}

export function getAIProvidersConfig() {
  return ConfigLoader.getInstance().getAIProvidersConfig()
}
