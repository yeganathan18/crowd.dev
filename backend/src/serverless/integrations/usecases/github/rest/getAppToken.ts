import axios, { AxiosRequestConfig } from 'axios'
import { createServiceChildLogger } from '../../../../../utils/logging'

const log = createServiceChildLogger('getAppToken')

export interface AppTokenResponse {
  token: string
  expiresAt: string
}

export const getAppToken = async (
  jwt: string,
  installationId: number,
): Promise<AppTokenResponse> => {
  try {
    const config = {
      method: 'post',
      url: `https://api.github.com/app/installations/${installationId}/access_tokens`,
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    } as AxiosRequestConfig

    const response = await axios(config)

    const data = response.data as any

    return {
      token: data.token,
      expiresAt: data.expires_at,
    }
  } catch (err: any) {
    log.error(err, { installationId }, 'Error fetching app token!')
    throw err
  }
}
