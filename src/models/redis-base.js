'use strict';

const IORedis = require('ioredis');

class RedisBase {

    constructor(uri = 'redis://localhost/0') {
        this.config = this.parse_uri(uri);
        this.clients = [];
    }

    /**
     * 
     * @param {*} option
     * 
     * if option is false, it returns this.clients[0] as the primary client. 
     * if option is not false, it returns a newly created client.
     * 
     * the new client may use for subscription
     * 
     * option can be callback function after connected
     * 
     * primary client has no on connect callback
     * 
     * if the primary client doesn't exist, it alway creates it first.
     * 
     * @returns IORedis client
     */
    async get_client(option = false) {
        if (this.clients.length === 0) {
            await this.create_new_client();
        }
        if (!option) {
            return this.clients[0].client;
        } else {
            await this.create_new_client(option !== true ? option : undefined);
            return this.clients[this.clients.length - 1].client;
        }
    }

    async get_client_id(client) {
        const item = this.clients.find(x => x.client === client);
        if (!item) return null;
        if (item.id) return item.id;
        item.id = await client.client('id');
        return item.id;
    }

    /**
     * helper function for send command
     * @param {*} param0 
     * @returns 
     */
    send_command({client, cmd, argv, replyEncoding = null}) {
        return new Promise((resolve, reject) => {
            const command = new IORedis.Command(cmd, argv, { replyEncoding }, 
                (err, result) => err ? 
                    reject(err) : 
                    resolve(Buffer.isBuffer(result) ? result.toString('utf-8') : result)
                );
            client.sendCommand(command);
        });
    }

    /**
     * 
     * @param {*} client to close this client, without client will close all clients
     * @returns 
     */
    async close(client) {
        if (this.clients.length === 0) return;
        if (client && client !== this.clients[0].client) {
            return await this.close_client(client);
        } else {
            while (this.clients.length > 0) {
                const { client } = this.clients.pop();
                await this.close_client(client);
            }
        }
    }

    async close_client(client) {
        await client.disconnect(false);
        await client.quit();
        const index = this.clients.findIndex(x => x.client === client);
        if (index > 0) {
            this.clients.splice(index, 1);
        }
    }


    get is_cluster() {
        return this.cluster;
    }

    async list_clients() {
        const client = await this.get_client();
        const result = await client.client('list');
        return result.split('\n').filter(x => x);
    }

    async list_commands() {
        const client = await this.get_client();
        return client.getBuiltinCommands();
    }

    async flushall() {
        const client = await this.get_client();
        if (this.is_cluster) {
            const nodes = client.nodes();
            const master_nodes = nodes.map(x => x && x.options && !x.options.readOnly);
            if (master_nodes.length === 0) {
                console.error('unexpected, no master node found!');
                return false;
            }
            for (const master_node of master_nodes) {
                if (!await master_node.flushall()) {
                    console.error('failed, master node flushall');
                }
            }
        } else {
            if (!await client.flushall()) {
                console.error('failed, node flushall');
                return false;
            }
        }
        return true;
    }

    parse_uri(uri) {
        let {protocol, host, username, password, port, pathname } = new URL(uri);
        if (protocol !== 'redis:') {
            throw new Error(`unexpected protocol ${protocol}`);
        }
        if (!port) port = 6379;
        if (!pathname) pathname = '/0';
        const db = Number(pathname.split('/').pop());
        const hosts = host.split(',');
        if (hosts.length === 1) {
            return {host, port, username, password, db};
        } else {
            const config = [];
            for (const host of hosts) {
                this.config.push({host, port, username, password, db});
            }
            return config;
        }
    }

    create_new_client(on_connected) {
        return new Promise(resolve => {
            let client;
            if (Array.isArray(this.config)) {
                this.cluster = true;
                client = new IORedis.Cluster(this.config, {
                    scaleReads: 'all',
                    enableReadyCheck: true,
                    autoResubscribe: !on_connected,
                    slotsRefreshTimeout: 500,
                    tls: {},
                    dnsLookup: (address, callback) => callback(null, address), 
                    clusterRetryStrategy: (times) => {
                        if (times === 1) return 1000;
                        return Math.min(times * 600, 3000);
                    }
                });
            } else {
                this.cluster = false;
                client = new IORedis({...this.config,
                    enableReadyCheck: true,
                    autoResubscribe: !on_connected,
                    retryStrategy: (times) => {
                        if (times === 1) return 500;
                        return Math.min(times * 600, 3000);
                    }
                });
            }
            const index = this.clients.length;
            this.clients.push({client});
            client.on('error', (err) => {
                const id = this.clients[index].id;
                this.clients[index].id = null;
                client.disconnect(true);
                console.error(err.message, {index, id});
            });
            client.on('connect', async () => {
                const id = await client.client('id');
                this.clients[index].id = id;
                //console.log('on connect', {index, id});
                if (index > 0 && on_connected) await on_connected(client);
                resolve();
            })   
        });
    }
}

module.exports = RedisBase;