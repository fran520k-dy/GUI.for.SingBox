import { ref } from 'vue'
import { defineStore } from 'pinia'
import { parse, stringify } from 'yaml'

import { debounce } from '@/utils'
import { Readfile, Writefile } from '@/utils/bridge'
import { ProfilesFilePath, ProxyGroup, FinalDnsType } from '@/constant'

export type ProfileType = {
  id: string
  name: string
  generalConfig: {
    mode: string
    'mixed-port': number
    'allow-lan': boolean
    'log-level': string
    'interface-name': string
  }
  advancedConfig: {
    port: number
    'socks-port': number
    secret: string
    'external-controller': string
    'external-ui': string
    'external-ui-url': string
    'tcp-concurrent': boolean
    profile: {
      'store-cache'?: boolean
      'store-fake-ip'?: boolean
    }
    'lan-allowed-ips': string[]
    'lan-disallowed-ips': string[]
  }
  tunConfig: {
    enable: boolean
    stack: string
    'auto-route': boolean
    interface_name: string
    mtu: number
    'strict-route': boolean
    'endpoint-independent-nat': boolean
  }
  dnsConfig: {
    enable: boolean
    fakeip: boolean
    strategy: string
    'local-dns': string
    'remote-dns': string
    'resolver-dns': string
    'remote-resolver-dns': string
    'final-dns': FinalDnsType
    'fake-ip-range-v4': string
    'fake-ip-range-v6': string
    'fake-ip-filter': string[]
  }
  proxyGroupsConfig: {
    id: string,
    tag: string
    type: ProxyGroup
    use: string[]
    proxies: {
      id: string
      type: string
      tag: string
    }[]
    url: string
    interval: number
    tolerance: number
  }[]
  rulesConfig: {
    id: string
    type: string
    payload: string
    proxy: string
  }[]
}

export const useProfilesStore = defineStore('profiles', () => {
  const profiles = ref<ProfileType[]>([])

  const setupProfiles = async () => {
    const data = await Readfile(ProfilesFilePath)
    profiles.value = parse(data)
  }

  const saveProfiles = debounce(async () => {
    await Writefile(ProfilesFilePath, stringify(profiles.value))
  }, 100)

  const addProfile = async (p: ProfileType) => {
    profiles.value.push(p)
    try {
      await saveProfiles()
    } catch (error) {
      profiles.value.pop()
      throw error
    }
  }

  const deleteProfile = async (id: string) => {
    const idx = profiles.value.findIndex((v) => v.id === id)
    if (idx === -1) return
    const backup = profiles.value.splice(idx, 1)[0]
    try {
      await saveProfiles()
    } catch (error) {
      profiles.value.splice(idx, 0, backup)
      throw error
    }
  }

  const editProfile = async (id: string, p: ProfileType) => {
    const idx = profiles.value.findIndex((v) => v.id === id)
    if (idx === -1) return
    const backup = profiles.value.splice(idx, 1, p)[0]
    try {
      await saveProfiles()
    } catch (error) {
      profiles.value.splice(idx, 1, backup)
      throw error
    }
  }

  const getProfileById = (id: string) => profiles.value.find((v) => v.id === id)

  return {
    profiles,
    setupProfiles,
    saveProfiles,
    addProfile,
    editProfile,
    deleteProfile,
    getProfileById
  }
})