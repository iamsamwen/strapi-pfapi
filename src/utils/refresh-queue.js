'use strict';

const Cacheable = require('../models/cacheable');
const get_class_config = require('../lib/get-class-config');

class RefreshQueue {

    constructor(redis_cache, local_cache, config = {}) {
        if (!redis_cache) {
            throw new Error('missing required redis_cache');
        }
        this.redis_cache = redis_cache;
        this.local_cache = local_cache;
        this.config = get_class_config(this, config);
    }

    async push(keys) {
        if (this.stopped || keys.length === 0) return;
        const promises = [];
        const score_keys = [];
        for (const key of keys) {
            promises.push(this.get_key_score_argv(score_keys, key));
        }
        await Promise.all(promises);
        const result = await this.push_refresh_queue(score_keys);
        if (this.config.max_queue_size) {
            const queue_size = await this.get_refresh_queue_size();
            if (queue_size > this.config.max_queue_size) {
                this.shift_refresh_queue(queue_size - this.config.max_queue_size);
            }
        }
        return result;
    }

    start() {
        this.interval_handle = setInterval(async () => {
            if (this.stopped) return;
            const queue_size = await this.get_refresh_queue_size();
            //console.log('refresh priority queue size', queue_size);
            if (queue_size > 0) {
                const start_ms = Date.now();
                // process from top
                for (let size = Math.ceil(queue_size * this.config.size_ratio); size > 0;) {
                    const max_refresh_size = size > this.config.batch_size ? this.config.batch_size : size;
                    await this.do_refresh(max_refresh_size);
                    // max time for refresh
                    if (Date.now() - start_ms > this.config.refresh_interval * this.config.time_ratio) break;
                    size -= max_refresh_size;
                }
                // remove from bottom
                const remove_count = Math.round(queue_size * this.config.remove_ratio);
                if (remove_count > 0) {
                    await this.shift_refresh_queue(remove_count);
                }
            }
        }, this.config.refresh_interval);
    }
    
    async on_refresh(key) {
        console.log('on_refresh receive', key);
        const cacheable = new Cacheable({key});
        return await cacheable.fetch_data(this.redis_cache, this.local_cache);
    }

    async do_refresh(max_refresh_size) {
        if (!max_refresh_size) max_refresh_size = this.config.batch_size;
        const promises = [];
        for (let i = 0; i < max_refresh_size; i++) {
            const { key } = await this.pop_refresh_queue();
            if (!key) break;
            promises.push(this.on_refresh(key));
        }
        if (promises.length > 0) {
            await Promise.all(promises);
        }
    }

    stop() {
        this.stopped = true;
        if (this.interval_handle) {
            clearInterval(this.interval_handle);
            this.interval_handle.unref();
            this.interval_handle = null;
        }
    }

    // support functions

    async get_key_score_argv(score_keys, key) {
        const cacheable = new Cacheable({key});
        const score = await cacheable.calculate_priority_score(this.redis_cache);
        score_keys.push(score, key);
    }
    
    async push_refresh_queue(score_keys) {
        const client = await this.redis_cache.get_client();
        const result = await client.zadd('REFRESH::priority-queue', ...score_keys);
        return result === score_keys.length / 2;
    }

    async pop_refresh_queue() {
        const client = await this.redis_cache.get_client();
        const result = await client.zpopmax('REFRESH::priority-queue');
        if (!result || result.length !== 2) return {};
        const key = result[0];
        const score = parseInt(result[1]);
        return {key, score};
    }

    async shift_refresh_queue(count) {
        const client = await this.redis_cache.get_client();
        const result = await client.zpopmin('REFRESH::priority-queue', count);
        if (!result || result.length === 0) return false;
        return true;
    }

    async get_refresh_queue_size() {
        const client = await this.redis_cache.get_client();
        return await client.zcount('REFRESH::priority-queue', '-inf', '+inf');
    }

}

module.exports = RefreshQueue;