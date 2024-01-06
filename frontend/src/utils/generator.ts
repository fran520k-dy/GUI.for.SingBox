import { parse, stringify } from 'yaml'

import { Readfile, Writefile } from '@/utils/bridge'
import { deepClone, ignoredError, APP_TITLE } from '@/utils'
import { KernelConfigFilePath, ProxyGroup } from '@/constant/kernel'
import { type ProfileType, useSubscribesStore, useRulesetsStore } from '@/stores'

export const generateRule = (rule: ProfileType['rulesConfig'][0]) => {
  const { type, payload, proxy } = rule
  if (type === 'rule_set') {
    const rulesetsStore = useRulesetsStore()
    const ruleset = rulesetsStore.getRulesetById(payload)
    if (ruleset) {
      return { rule_set: ruleset.tag, outbound: proxy }
    } else {
      return null
    }
  }
  const result_rule: Record<string, any> = { outbound: proxy }
  result_rule[type] = payload.split(',').map((r) => r.trim())
  return result_rule
}

type ProxiesType = { type: string; tag: string }

const generateRuleSets = async (rules: ProfileType['rulesConfig']) => {
  const rulesetsStore = useRulesetsStore()
  const ruleSets: { tag: string; type: string; format: string; path: string }[] = []
  rules
    .filter((rule) => rule.type === 'rule_set')
    .forEach((rule) => {
      const ruleset = rulesetsStore.getRulesetById(rule.payload)
      if (ruleset) {
        ruleSets.push({
          tag: ruleset.tag,
          type: 'local',
          format: ruleset.format,
          path: ruleset.path.replace('data/', '../')
        })
      }
    })
  return ruleSets
}

const generateDnsConfig = async (profile: ProfileType) => {
  // const proxyTag = profile.proxyGroupsConfig[0].tag
  // const remote_dns = ['rule', 'global'].includes(profile.generalConfig.mode)
  //   ? profile.dnsConfig['remote-dns']
  //   : profile.dnsConfig['local-dns']
  // const remote_resolver_dns = ['rule', 'global'].includes(profile.generalConfig.mode)
  //   ? profile.dnsConfig['remote-resolver-dns']
  //   : profile.dnsConfig['resolver-dns']
  // const local_dns = ['rule', 'direct'].includes(profile.generalConfig.mode)
  //   ? profile.dnsConfig['local-dns']
  //   : profile.dnsConfig['remote-dns']
  // const resolver_dns = ['rule', 'direct'].includes(profile.generalConfig.mode)
  //   ? profile.dnsConfig['resolver-dns']
  //   : profile.dnsConfig['remote-resolver-dns']
  // const remote_detour = ['rule', 'global'].includes(profile.generalConfig.mode) ? proxyTag : 'direct'
  // const direct_detour = ['rule', 'direct'].includes(profile.generalConfig.mode) ? 'direct' : proxyTag

  const proxyTag = profile.proxyGroupsConfig[0].tag
  const remote_dns = profile.dnsConfig['remote-dns']
  const remote_resolver_dns = profile.dnsConfig['remote-resolver-dns']
  const local_dns = profile.dnsConfig['local-dns']
  const resolver_dns = profile.dnsConfig['resolver-dns']
  const remote_detour = proxyTag
  const direct_detour = 'direct'

  return {
    servers: [
      {
        tag: 'remote-dns',
        address: remote_dns,
        address_resolver: 'remote-resolver-dns',
        detour: remote_detour
      },
      {
        tag: 'local-dns',
        address: local_dns,
        address_resolver: 'resolver-dns',
        detour: direct_detour
      },
      {
        tag: 'resolver-dns',
        address: resolver_dns,
        detour: direct_detour
      },
      {
        tag: 'remote-resolver-dns',
        address: remote_resolver_dns,
        detour: remote_detour
      },
      ...(profile.dnsConfig.fakeip
        ? [
            {
              tag: 'fakeip-dns',
              address: 'fakeip'
            }
          ]
        : []),
      {
        tag: 'block',
        address: 'rcode://success'
      }
    ],
    rules: [
      {
        outbound: 'any',
        server: 'local-dns',
        disable_cache: true
      },
      ...(profile.dnsConfig.fakeip
        ? [
            {
              type: 'logical',
              mode: 'and',
              rules: [
                {
                  domain_suffix: profile.dnsConfig['fake-ip-filter'],
                  invert: true
                },
                {
                  query_type: ['A', 'AAAA']
                }
              ],
              server: 'fakeip-dns'
            }
          ]
        : []),
      {
        type: 'logical',
        mode: 'and',
        rules: [
          {
            rule_set: 'built-in-geosite-geolocation-!cn',
            invert: true
          },
          {
            rule_set: 'built-in-geosite-cn'
          }
        ],
        server: 'local-dns'
      },
      {
        rule_set: 'built-in-geosite-geolocation-!cn',
        server: 'remote-dns'
      }
    ]
  }
}

const generateInBoundsConfig = async (profile: ProfileType) => {
  const inbounds = []

  if (profile.generalConfig['mixed-port'] > 0) {
    inbounds.push({
      type: 'mixed',
      listen: profile.generalConfig['allow-lan'] ? '::' : '127.0.0.1',
      listen_port: profile.generalConfig['mixed-port'],
      tcp_multi_path: profile.advancedConfig['tcp-concurrent'],
      sniff: true
    })
  }

  if (profile.advancedConfig.port > 0) {
    inbounds.push({
      type: 'http',
      listen: profile.generalConfig['allow-lan'] ? '::' : '127.0.0.1',
      listen_port: profile.advancedConfig.port,
      tcp_multi_path: profile.advancedConfig['tcp-concurrent'],
      sniff: true
    })
  }

  if (profile.advancedConfig['socks-port'] > 0) {
    inbounds.push({
      type: 'socks',
      listen: profile.generalConfig['allow-lan'] ? '::' : '127.0.0.1',
      listen_port: profile.advancedConfig['socks-port'],
      tcp_multi_path: profile.advancedConfig['tcp-concurrent'],
      sniff: true
    })
  }

  if (profile.tunConfig.enable) {
    inbounds.push({
      type: 'tun',
      interface_name: profile.tunConfig.interface_name,
      inet4_address: '172.19.0.1/30',
      inet6_address: 'fdfe:dcba:9876::1/126',
      mtu: profile.tunConfig.mtu,
      auto_route: profile.tunConfig['auto-route'],
      strict_route: profile.tunConfig['strict-route'],
      sniff: true,
      sniff_override_destination: false,
      endpoint_independent_nat: profile.tunConfig['endpoint-independent-nat'],
      stack: profile.tunConfig.stack.toLowerCase()
    })
  }
  return inbounds
}

const generateOutBoundsConfig = async (groups: ProfileType['proxyGroupsConfig']) => {
  const outbounds = []

  const subs = new Set<string>()

  groups.forEach((group) => {
    group.use.forEach((use) => subs.add(use))
  })

  const proxyMap: Record<string, ProxiesType[]> = {}
  const proxyTags = new Set<string>()
  const proxies: any = []

  const subscribesStore = useSubscribesStore()
  for (const subID of subs) {
    const sub = subscribesStore.getSubscribeById(subID)
    if (sub) {
      try {
        const subStr = await Readfile(sub.path)
        const subProxies = JSON.parse(subStr)
        proxyMap[sub.id] = subProxies
        for (const subProxy of subProxies) {
          proxyTags.add(subProxy.tag)
          proxies.push(subProxy)
        }
      } catch (error) {
        console.log(error)
      }
    }
  }

  for (const group of groups) {
    for (const proxy of group.proxies)
      if (proxy.type !== 'built-in') {
        if (!proxyTags.has(proxy.tag)) {
          if (!proxyMap[proxy.type]) {
            const sub = subscribesStore.getSubscribeById(proxy.type)
            if (sub) {
              try {
                const subStr = await Readfile(sub.path)
                const subProxies = JSON.parse(subStr)
                proxyMap[sub.id] = subProxies
              } catch (error) {
                console.log(error)
              }
            }
          }
          if (proxyMap[proxy.type]) {
            const subProxy = proxyMap[proxy.type].find((v) => v.tag === proxy.tag)
            if (subProxy) {
              proxyTags.add(proxy.tag)
              proxies.push(subProxy)
            }
          }
        }
      }
  }

  function getGroupOutbounds(group_proxies: any[], uses: string[]) {
    const outbounds = group_proxies.map((proxy) => proxy.tag)
    outbounds.push(...uses.map((use) => proxyMap[use].map((proxy) => proxy.tag)).flat())
    return outbounds
  }

  groups.forEach((group) => {
    group.type === ProxyGroup.Select &&
      outbounds.push({
        tag: group.tag,
        type: 'selector',
        outbounds: getGroupOutbounds(group.proxies, group.use)
      })
    group.type === ProxyGroup.UrlTest &&
      outbounds.push({
        tag: group.tag,
        type: 'urltest',
        outbounds: getGroupOutbounds(group.proxies, group.use),
        url: group.url,
        interval: group.interval.toString() + 's',
        tolerance: group.tolerance
      })
  })
  outbounds.push(...proxies)
  return outbounds
}

const generateRouteConfig = async (profile: ProfileType) => {
  const proxyTag = profile.proxyGroupsConfig[0].tag

  const route: Record<string, any> = {
    rule_set: [
      {
        type: 'remote',
        tag: 'built-in-geoip-cn',
        format: 'binary',
        url: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geoip/cn.srs',
        download_detour: 'direct'
      },
      {
        type: 'remote',
        tag: 'built-in-geosite-cn',
        format: 'binary',
        url: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/cn.srs',
        download_detour: 'direct'
      },
      {
        type: 'remote',
        tag: 'built-in-geosite-geolocation-!cn',
        format: 'binary',
        url: 'https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@sing/geo/geosite/geolocation-!cn.srs',
        download_detour: 'direct'
      },
      ...(await generateRuleSets(profile.rulesConfig))
    ],
    rules: [
      {
        type: 'logical',
        mode: 'or',
        rules: [
          {
            protocol: 'dns'
          },
          {
            port: 53
          }
        ],
        outbound: 'dns-out'
      },
      {
        network: 'udp',
        port: 443,
        outbound: 'block'
      }
    ]
  }

  if (profile.generalConfig.mode == 'rule') {
    route.rules.push(
      ...[
        {
          ip_is_private: true,
          outbound: 'direct'
        },
        {
          type: 'logical',
          mode: 'and',
          rules: [
            {
              rule_set: 'built-in-geosite-geolocation-!cn',
              invert: true
            },
            {
              rule_set: ['built-in-geoip-cn', 'built-in-geosite-cn']
            }
          ],
          outbound: 'direct'
        },
        {
          rule_set: 'built-in-geosite-geolocation-!cn',
          outbound: proxyTag
        }
      ]
    )
    route.rules.push(
      ...profile.rulesConfig
        .filter((v) => v.type !== 'final')
        .map((rule) => generateRule(rule))
        .filter((v) => v != null)
    )
    const final = profile.rulesConfig.filter((v) => v.type === 'final')
    if (final.length > 0) {
      route['final'] = final[0].proxy
    }
  } else if (profile.generalConfig.mode == 'global') {
    route['final'] = proxyTag
  } else {
    route['final'] = 'direct'
  }

  const interface_name = profile.generalConfig['interface-name']
  if (interface_name == 'Auto') {
    route['auto_detect_interface'] = true
  } else {
    route['default_interface'] = interface_name
  }
  return route
}

export const generateConfig = async (profile: ProfileType) => {
  profile = deepClone(profile)

  const config: Record<string, any> = {
    log: { level: profile.generalConfig['log-level'], timestamp: true },
    experimental: {
      clash_api: {
        external_controller: profile.advancedConfig['external-controller'],
        external_ui: profile.advancedConfig['external-ui'],
        secret: profile.advancedConfig.secret,
        external_ui_download_url: profile.advancedConfig['external-ui-url']
      },
      cache_file: {
        enabled: profile.advancedConfig.profile['store-cache'],
        store_fakeip: profile.advancedConfig.profile['store-fake-ip']
      }
    },
    inbounds: await generateInBoundsConfig(profile),
    outbounds: [
      ...(await generateOutBoundsConfig(profile.proxyGroupsConfig)),
      {
        type: 'direct',
        tag: 'direct'
      },
      {
        type: 'dns',
        tag: 'dns-out'
      },
      {
        type: 'block',
        tag: 'block'
      }
    ],
    route: await generateRouteConfig(profile)
  }

  if (profile.dnsConfig.enable) {
    config['dns'] = {
      ...(await generateDnsConfig(profile)),
      fakeip: {
        enabled: profile.dnsConfig.fakeip,
        inet4_range: profile.dnsConfig['fake-ip-range-v4'],
        inet6_range: profile.dnsConfig['fake-ip-range-v6']
      },
      final: profile.dnsConfig['final-dns'],
      strategy: profile.dnsConfig.strategy
    }
  }
  return config
}

export const generateConfigFile = async (profile: ProfileType) => {
  // const header = `# DO NOT EDIT - Generated by ${APP_TITLE}\n`

  const config = await generateConfig(profile)

  await Writefile(KernelConfigFilePath, JSON.stringify(config, null, 2))
}

export const addToRuleSet = async (ruleset: 'direct' | 'reject' | 'proxy', payload: string) => {
  const path = `data/rulesets/${ruleset}.yaml`
  const content = (await ignoredError(Readfile, path)) || '{}'
  const { payload: p = [] } = parse(content)
  p.unshift(payload)
  await Writefile(path, stringify({ payload: [...new Set(p)] }))
}