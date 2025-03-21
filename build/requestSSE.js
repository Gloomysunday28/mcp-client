export default new (class RequestSSE {
    request(url, method, params, config) {
        const abortController = config?.abortController || new AbortController();
        const timer = setTimeout(() => {
            clearTimeout(timer);
            abortController.abort();
        }, 5 * 60 * 1000);
        const { streamCallback } = (config || {});
        // @ts-ignore
        return fetch(`${getBaseAPI()}${url}`, {
            method,
            body: params,
            signal: abortController.signal,
        }).then(async (response) => {
            const contentType = response.headers.get('Content-Type');
            if (contentType !== 'text/event-stream') {
                const data = await response.json();
                return streamCallback?.(data);
            }
            if (!response.body)
                return;
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let responseValue;
            let chunks = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    return {
                        ...responseValue,
                        data: {
                            result: {
                                data: streamCallback?.(null, true),
                            },
                        },
                    };
                }
                const chunk = decoder.decode(value, { stream: true });
                chunks += chunk;
                const abortIndex = chunks.indexOf('\n\n');
                if (!~abortIndex) {
                    continue;
                }
                /** 截取一条完整的信息 */
                const event = chunks.slice(0, abortIndex);
                if (event) {
                    const parsedEvent = event.split(': ').slice(1).join(': ');
                    const parseValue = JSON.parse(parsedEvent);
                    if (!responseValue) {
                        responseValue = parseValue;
                    }
                    const { success, msg } = parseValue;
                    if (success) {
                        streamCallback?.(parseValue);
                    }
                    else {
                        streamCallback?.(parseValue);
                    }
                }
                /** chunk如果过长, 取当前chunk 的剩余部分作为下一次头部信息  */
                chunks = chunks.slice(abortIndex + 2);
            }
        });
    }
    get(url, params, config) {
        return this.request(`${url}${params ? `?${new URLSearchParams(params).toString()}` : ''}`, 'GET', void 0, config);
    }
    post(url, params, config) {
        return this.request(url, 'POST', JSON.stringify(params), config);
    }
})();
