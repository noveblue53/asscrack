// A fake UPnP router (IGD) on 127.0.0.1 for the tests. No SSDP multicast is sent and no packet leaves this PC.
import http from 'node:http'
import UPnP from '@silentbot1/nat-api/lib/upnp/index.js'
import Device from '@silentbot1/nat-api/lib/upnp/device.js'
import { setTimeout as sleep } from 'node:timers/promises'
import { createPortMapper } from '../../src/network/port-mapper.mjs'

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1'

function soap(action, inner) {
    return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action}Response xmlns:u="${SERVICE}">${inner}</u:${action}Response></s:Body></s:Envelope>`
}

// mode.externalIp: the answer to GetExternalIPAddress. mode.addStatus: the HTTP status of AddPortMapping.
// mode.addDelay: ms before the answer to AddPortMapping.
// Returns { log, port, close() }. log has one entry for each request: { action, extPort, intPort, proto, client, ttl }.
export function startIgd(mode = {}) {
    const log = []
    const server = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/desc.xml') {
            res.setHeader('Content-Type', 'text/xml')
            res.end(`<root><device><serviceList><service><serviceType>${SERVICE}</serviceType><controlURL>/ctl</controlURL><SCPDURL>/scpd.xml</SCPDURL></service></serviceList></device></root>`)
            return
        }
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
            const action = /#(\w+)"?$/.exec(String(req.headers.soapaction ?? ''))?.[1] ?? 'unknown'
            const tag = n => new RegExp(`<${n}>([^<]*)</${n}>`).exec(body)?.[1]
            log.push({ action, extPort: tag('NewExternalPort'), intPort: tag('NewInternalPort'), proto: tag('NewProtocol'), client: tag('NewInternalClient'), ttl: tag('NewLeaseDuration') })
            const status = action === 'AddPortMapping' ? (mode.addStatus ?? 200) : 200
            const answer = () => {
                res.writeHead(status, { 'Content-Type': 'text/xml' })
                if (status !== 200) {
                    res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorCode>606</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>')
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

// Substitute only SSDP discovery. The real transport reads the descriptor and sends SOAP requests.
export function fakeClient(igdPort, { fail, delay = 0 } = {}) {
    const transport = Object.create(UPnP.prototype)
    const device = new Device({ url: `http://127.0.0.1:${igdPort}/desc.xml` })
    const controller = new AbortController()
    transport.findGateway = async () => {
        if (delay) await sleep(delay, undefined, { signal: controller.signal })
        if (fail) throw new Error(fail)
        return { gateway: device, address: '127.0.0.1' }
    }
    transport.destroy = () => controller.abort()
    return createPortMapper(transport)
}
