// Use the UPnP transport directly. The node owns the TCP lease and its renewal timer.
import UPnP from '@silentbot1/nat-api/lib/upnp/index.js'

export function createPortMapper(client = new UPnP()) {
    function mapping({ publicPort, localPort, localAddress, ttl }) {
        return {
            public: publicPort,
            private: { port: localPort, host: localAddress },
            protocol: 'TCP',
            description: 'ASSCRACK',
            ttl
        }
    }
    return {
        externalIp: () => client.externalIp(),
        map: options => client.portMapping(mapping(options)),
        unmap: options => client.portUnmapping(mapping(options)),
        close: () => client.destroy()
    }
}
