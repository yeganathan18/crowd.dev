import { OPENSEARCH_CONFIG } from '@/conf'
import {
  IndexVersions,
  OPENSEARCH_INDEX_MAPPINGS,
  OPENSEARCH_INDEX_SETTINGS,
  OpenSearchIndex,
} from '@/types'
import { Logger, LoggerBase } from '@crowd/logging'
import { Client } from '@opensearch-project/opensearch'
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws'
import { IIndexRequest, ISearchHit } from './opensearch.data'
import { IS_DEV_ENV } from '@crowd/common'

export class OpenSearchService extends LoggerBase {
  private readonly client: Client

  constructor(parentLog: Logger) {
    super(parentLog)

    const config = OPENSEARCH_CONFIG()
    if (config.region) {
      this.client = new Client({
        node: config.node,
        ...AwsSigv4Signer({
          region: config.region,
          service: 'es',
          getCredentials: async () => {
            return {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            }
          },
        }),
      })
    } else {
      this.client = new Client({
        node: config.node,
      })
    }
  }

  private async doesIndexExist(indexName: string): Promise<boolean> {
    try {
      const exists = await this.client.indices.exists({ index: indexName })
      return exists.body
    } catch (err) {
      this.log.error(err, { indexName }, 'Failed to check if index exists!')
      throw err
    }
  }

  private async doesAliasExist(aliasName: string): Promise<boolean> {
    try {
      const exists = await this.client.indices.existsAlias({
        name: aliasName,
      })
      return exists.body
    } catch (err) {
      this.log.error(err, { aliasName }, 'Failed to check if alias exists!')
      throw err
    }
  }

  private async doesAliasPointToIndex(indexName: string, aliasName: string): Promise<boolean> {
    try {
      const exists = await this.client.indices.existsAlias({
        name: aliasName,
        index: indexName,
      })
      return exists.body
    } catch (err) {
      this.log.error(err, { aliasName, indexName }, 'Failed to check if alias points to the index!')
      throw err
    }
  }

  public async createIndexWithVersion(indexName: OpenSearchIndex, version: number): Promise<void> {
    try {
      const settings = OPENSEARCH_INDEX_SETTINGS[indexName]
      const mappings = OPENSEARCH_INDEX_MAPPINGS[indexName]

      await this.client.indices.create({
        index: `${indexName}_v${version}`,
        body: {
          settings,
          mappings,
        },
      })
    } catch (err) {
      this.log.error(err, { indexName }, 'Failed to create versioned index!')
      throw err
    }
  }

  public async createAlias(indexName: string, aliasName: string): Promise<void> {
    try {
      await this.client.indices.putAlias({
        index: indexName,
        name: aliasName,
      })
    } catch (err) {
      this.log.error(err, { aliasName, indexName }, 'Failed to create alias!')
      throw err
    }
  }

  private async pointAliasToCorrectIndex(indexName: string, aliasName: string): Promise<void> {
    try {
      // Updates alias by removing existing references and points it to the new index
      await this.client.indices.updateAliases({
        body: {
          actions: [
            { remove: { index: '*', alias: aliasName } },
            { add: { index: indexName, alias: aliasName } },
          ],
        },
      })
      this.log.info('Alias successfully updated', { aliasName, indexName })
    } catch (err) {
      this.log.error(err, { aliasName, indexName }, 'Failed to update alias!')
    }
  }

  public async reIndex(sourceIndex: string, targetIndex: string): Promise<void> {
    try {
      await this.client.reindex({
        wait_for_completion: true,
        refresh: true,
        body: {
          source: {
            index: sourceIndex,
          },
          dest: {
            index: targetIndex,
          },
        },
      })
    } catch (err) {
      this.log.error(err, { sourceIndex, targetIndex }, 'Failed to reindex!')
      throw err
    }
  }

  public async deleteIndex(indexName: string): Promise<void> {
    try {
      await this.client.indices.delete({
        index: indexName,
      })
    } catch (err) {
      this.log.error(err, { indexName }, 'Failed to delete index!')
      throw err
    }
  }

  public async getIndexSettings(indexName: OpenSearchIndex): Promise<unknown> {
    try {
      const version = IndexVersions.get(indexName)
      const settings = await this.client.indices.getSettings({
        index: `${indexName}_v${version}`,
      })
      return settings.body
    } catch (err) {
      this.log.error(err, { indexName }, 'Failed to get index settings!')
      throw err
    }
  }

  public async getIndexMappings(indexName: OpenSearchIndex): Promise<unknown> {
    try {
      const version = IndexVersions.get(indexName)
      const mappings = await this.client.indices.getMapping({
        index: `${indexName}_v${version}`,
      })
      return mappings.body
    } catch (err) {
      this.log.error(err, { indexName }, 'Failed to get index mappings!')
      throw err
    }
  }

  public async setIndexMappings(indexName: OpenSearchIndex): Promise<void> {
    try {
      const mappings = OPENSEARCH_INDEX_MAPPINGS[indexName]
      const version = IndexVersions.get(indexName)

      await this.client.indices.putMapping({
        index: `${indexName}_v${version}`,
        body: mappings,
      })
    } catch (err) {
      this.log.error(err, { indexName }, 'Failed to set index mappings!')
      throw err
    }
  }

  private async ensureIndexAndAliasExists(indexName: OpenSearchIndex) {
    const version = IndexVersions.get(indexName)
    const indexNameWithVersion = `${indexName}_v${version}`

    // indexName is the alias name and indexNameWithVersion is the actual index name under the hood
    const aliasName = indexName

    const indexExists = await this.doesIndexExist(indexNameWithVersion)
    const aliasExists = await this.doesAliasExist(aliasName)
    const aliasPointsToIndex = await this.doesAliasPointToIndex(indexNameWithVersion, aliasName)

    if (IS_DEV_ENV) {
      if (!indexExists) {
        this.log.info('Creating versioned index with settings and mappings!', {
          indexNameWithVersion,
        })
        await this.createIndexWithVersion(indexName, version)
      }

      if (!aliasExists) {
        this.log.info('Creating alias for index!', { indexNameWithVersion, aliasName })
      }
    } else {
      if (!aliasExists || !indexExists || !aliasPointsToIndex) {
        throw new Error('Index and alias are either missing or not properly configured!')
      }
    }

    this.log.info('Index and alias already exists with proper configuration!', {
      indexNameWithVersion,
      aliasName,
    })
  }

  public async initialize() {
    await this.client.cluster.putSettings({
      body: {
        persistent: {
          'action.auto_create_index': 'false',
        },
      },
    })
    await this.ensureIndexAndAliasExists(OpenSearchIndex.MEMBERS)
    await this.ensureIndexAndAliasExists(OpenSearchIndex.ACTIVITIES)
  }

  public async removeFromIndex(id: string, index: OpenSearchIndex): Promise<void> {
    try {
      const version = IndexVersions.get(index)
      await this.client.delete({
        id,
        index: `${index}_v${version}`,
        refresh: true,
      })
    } catch (err) {
      if (err.meta.statusCode === 404) {
        this.log.debug(err, { id, index }, 'Document not found in index!')
        return
      }
      this.log.error(err, { id, index }, 'Failed to remove document from index!')
      throw new Error(`Failed to remove document with id: ${id} from index ${index}!`)
    }
  }

  public async index<T>(id: string, index: OpenSearchIndex, body: T): Promise<void> {
    const version = IndexVersions.get(index)
    try {
      await this.client.index({
        id,
        index: `${index}_v${version}`,
        body,
        refresh: true,
      })
    } catch (err) {
      this.log.error(err, { id, index }, 'Failed to index document!')
      throw new Error(`Failed to index document with id: ${id} in index ${index}!`)
    }
  }

  public async bulkIndex<T>(index: OpenSearchIndex, batch: IIndexRequest<T>[]): Promise<void> {
    try {
      const body = []
      const version = IndexVersions.get(index)
      for (const doc of batch) {
        body.push({
          index: { _index: `${index}_v${version}`, _id: doc.id },
        })
        body.push({
          ...doc.body,
        })
      }

      await this.client.bulk({
        body,
        refresh: true,
      })
    } catch (err) {
      this.log.error(err, { index }, 'Failed to bulk index documents!')
      throw new Error(`Failed to bulk index documents in index ${index}!`)
    }
  }

  public async search<T>(
    index: OpenSearchIndex,
    query?: unknown,
    aggs?: unknown,
    size?: number,
    sort?: unknown[],
    searchAfter?: unknown,
    sourceIncludeFields?: string[],
    sourceExcludeFields?: string[],
  ): Promise<ISearchHit<T>[] | unknown> {
    try {
      const version = IndexVersions.get(index)
      const payload = {
        index: `${index}_v${version}`,
        _source_excludes: sourceExcludeFields,
        _source_includes: sourceIncludeFields,
        body: {
          size: aggs ? 0 : undefined,
          query,
          aggs,
          search_after: searchAfter ? [searchAfter] : undefined,
          sort,
        },
        size,
      }

      const data = await this.client.search(payload)

      if (query) {
        return data.body.hits.hits
      } else {
        return data.body.aggregations
      }
    } catch (err) {
      this.log.error(err, { index, query }, 'Failed to search documents!')
      throw new Error('Failed to search documents!')
    }
  }
}
