import { createLibp2p } from 'libp2p'

function limitedConnectionOptions(options) {
    if (options?.runOnTransientConnection === undefined) return options
    const { runOnTransientConnection, ...rest } = options
    return { runOnLimitedConnection: runOnTransientConnection, ...rest }
}

function duplexStream(stream) {
    if (stream.source !== undefined) return stream

    // libp2p v3 exposes reads on the stream itself. Keep the room protocols' iterable
    // interface and their existing one-way EOF behavior over the new message stream.
    stream.source = stream
    stream.sink = async source => {
        try {
            for await (const chunk of source) {
                if (!stream.send(chunk)) await stream.onDrain()
            }
            await stream.close()
        } catch (error) {
            stream.abort(error)
            throw error
        }
    }
    return stream
}

export async function createStreamCompatibleLibp2p(options) {
    const node = await createLibp2p({ ...options, start: false })
    const wrapped = new WeakSet()

    function duplexConnection(connection) {
        if (!wrapped.has(connection)) {
            wrapped.add(connection)
            const newStream = connection.newStream.bind(connection)
            connection.newStream = async (protocol, options) => duplexStream(await newStream(protocol, limitedConnectionOptions(options)))
        }
        return connection
    }

    node.addEventListener('connection:open', ({ detail }) => duplexConnection(detail))
    const handle = node.handle.bind(node)
    node.handle = (protocol, onStream, options) => handle(protocol,
        (stream, connection) => onStream({ stream: duplexStream(stream), connection: duplexConnection(connection) }),
        limitedConnectionOptions(options))

    const dial = node.dial.bind(node)
    node.dial = async (...args) => duplexConnection(await dial(...args))
    const dialProtocol = node.dialProtocol.bind(node)
    node.dialProtocol = async (target, protocol, options) => duplexStream(await dialProtocol(target, protocol, limitedConnectionOptions(options)))

    if (options?.start !== false) await node.start()
    return node
}
