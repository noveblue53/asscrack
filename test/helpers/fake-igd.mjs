// A fake UPnP router (IGD) on 127.0.0.1 for the tests. No SSDP multicast is sent and no packet leaves this PC.
// Moved from the probe work-orders/reach-20261118/probe/upnp-fake-igd.mjs.
// The test imports the transitive @achingbrain/nat-port-mapper classes, because the gateway option of uPnPNAT
// cannot point at a fake router (it gives a device with an empty service list: "Service not found").
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// node_modules/@libp2p/upnp-nat/dist/src/index.js -> node_modules
const NM = path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@libp2p/upnp-nat'))), '..', '..', '..', '..')
const mapperDir = path.join(NM, '@achingbrain', 'nat-port-mapper', 'dist', 'src')
const { NatAPI } = await import(pathToFileURL(path.join(mapperDir, 'index.js')).href)
const { UPNPClient } = await import(pathToFileURL(path.join(mapperDir, 'upnp', 'index.js')).href)

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1'

function soap(action, inner) {
    return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${SERVICE}">${inner}</u:${action}Response></s:Body></s:Envelope>`
}

// mode.externalIp: the answer to GetExternalIPAddress. mode.addStatus: the HTTP status of AddPortMapping.
// mode.addDelay: ms before the answer to AddPortMapping.
// Returns { log, port, close() }. log has one entry for each request: { action, extPort, intPort, proto, client }.
export function startIgd(mode = {}) {
    const log = []
    const server = http.createServer((req, res) => {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
            const action = /#(\w+)"?$/.exec(String(req.headers.soapaction ?? ''))?.[1] ?? 'unknown'
            const tag = n => new RegExp(`<${n}>([^<]*)</${n}>`).exec(body)?.[1]
            log.push({ action, extPort: tag('NewExternalPort'), intPort: tag('NewInternalPort'), proto: tag('NewProtocol'), client: tag('NewInternalClient') })
            const status = action === 'AddPortMapping' ? (mode.addStatus ?? 200) : 200
            const answer = () => {
                res.writeHead(status, { 'Content-Type': 'text/xml' })
                if (status !== 200) {
                    res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>UPnPError</faultstring></s:Fault></s:Body></s:Envelope>')
                    return
                }
                if (action === 'GetExternalIPAddress') {
                    res.end(soap(action, `<NewExternalIPAddress>${mode.externalIp ?? '93.184.216.34'}</NewExternalIPAddress>`))
                    return
                }
                res.end(soap(action, ''))
            }
            if (action === 'AddPortMapping' && mode.addDelay > 0) setTimeout(answer, mode.addDelay)
            else answer()
        })
    })
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
        log,
        port: server.address().port,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) })
    })))
}

// A discovery function for UPNPClient: it gives the fake IGD with no SSDP.
// fail: a discovery error text. delay: ms before the answer; cancel() rejects a waiting discovery.
export function fakeDiscover(igdPort, { fail, delay = 0 } = {}) {
    const service = {
        location: new URL(`http://127.0.0.1:${igdPort}/desc.xml`),
        details: { device: { serviceList: { service: [{ serviceType: SERVICE, controlURL: '/ctl', SCPDURL: '/scpd.xml' }] }, deviceList: { device: [] } } },
        expires: Date.now() + 3600000,
        serviceType: 'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        uniqueServiceName: 'fake'
    }
    return () => {
        let timer = null
        let rejectWait = null
        return {
            gateway: async () => {
                if (delay > 0) {
                    await new Promise((resolve, reject) => {
                        rejectWait = reject
                        timer = setTimeout(resolve, delay)
                    })
                }
                if (fail) throw new Error(fail)
                return service
            },
            cancel: async () => {
                if (timer) clearTimeout(timer)
                rejectWait?.(new Error('discovery cancelled'))
            }
        }
    }
}

// A NatAPI client on the fake IGD, for the createAsscrackNode test option upnpClient.
export function fakeClient(igdPort, options = {}) {
    return new NatAPI({ description: 'asscrack', ttl: 7200, keepAlive: true }, UPNPClient.createClient(fakeDiscover(igdPort, options)))
}
