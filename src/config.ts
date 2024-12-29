import { ProviderConfig } from './types'
import fs from 'fs'
import yaml from 'js-yaml'

export function getConfig() {
  const configFileName = process.env.CONFIG_FILE || './config.yaml'
  const fileContents = fs.readFileSync(configFileName, 'utf8')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = yaml.load(fileContents) as Record<string, any>
  return data
}

export function getAIProvidersConfig() {
  const config = getConfig()
  const providers: ProviderConfig[] = config.bots.map((bot: ProviderConfig) => ({
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
  }))
  return providers
}
