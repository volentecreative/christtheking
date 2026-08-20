/**
 * Minimal Webflow Data API v2 client — no npm dependencies, uses global fetch.
 * Handles the 60 req/min rate limit with backoff and honours Retry-After.
 */

const API = 'https://api.webflow.com/v2';

export class WebflowError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'WebflowError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WebflowClient {
  /**
   * @param {string} token  Site API token (Webflow → Site settings → Apps & integrations → API access)
   * @param {object} [options]
   * @param {number} [options.minIntervalMs] Spacing between write calls.
   */
  constructor(token, { minIntervalMs = 1100 } = {}) {
    if (!token) throw new WebflowError('Missing Webflow API token.');
    this.token = token;
    this.minIntervalMs = minIntervalMs;
    this.lastCallAt = 0;
  }

  async #request(path, { method = 'GET', body, attempt = 1 } = {}) {
    const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
    if (method !== 'GET' && wait > 0) await sleep(wait);

    let response;
    try {
      response = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (attempt <= 3) {
        await sleep(1000 * attempt);
        return this.#request(path, { method, body, attempt: attempt + 1 });
      }
      throw new WebflowError(`Network error calling Webflow: ${error.message}`);
    }

    this.lastCallAt = Date.now();

    if (response.status === 429 || response.status >= 500) {
      if (attempt <= 4) {
        const retryAfter = Number(response.headers.get('retry-after')) || 0;
        await sleep(retryAfter ? retryAfter * 1000 : 2000 * attempt);
        return this.#request(path, { method, body, attempt: attempt + 1 });
      }
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }

    if (!response.ok) {
      const detail =
        (payload && (payload.message || payload.msg || payload.err)) || response.statusText;
      const details = payload && payload.details ? ` ${JSON.stringify(payload.details)}` : '';
      throw new WebflowError(`Webflow ${response.status}: ${detail}${details}`, {
        status: response.status,
        body: payload,
      });
    }

    return payload;
  }

  async listAllItems(collectionId) {
    const items = [];
    let offset = 0;

    for (;;) {
      const page = await this.#request(
        `/collections/${collectionId}/items?limit=100&offset=${offset}`
      );
      const batch = page.items || [];
      items.push(...batch);

      const total = page.pagination ? page.pagination.total : batch.length;
      offset += batch.length;
      if (!batch.length || offset >= total) break;
    }

    return items;
  }

  /** Create an item and publish it in one call. */
  async createLiveItem(collectionId, fieldData) {
    const result = await this.#request(`/collections/${collectionId}/items/live`, {
      method: 'POST',
      body: { items: [{ isArchived: false, isDraft: false, fieldData }] },
    });
    if (result && Array.isArray(result.items)) return result.items[0];
    return result;
  }

  /** Create an item as a draft (used by --draft). */
  async createDraftItem(collectionId, fieldData) {
    const result = await this.#request(`/collections/${collectionId}/items`, {
      method: 'POST',
      body: { items: [{ isArchived: false, isDraft: true, fieldData }] },
    });
    if (result && Array.isArray(result.items)) return result.items[0];
    return result;
  }

  /** Patch a live item in place. */
  async updateLiveItem(collectionId, itemId, fieldData) {
    return this.#request(`/collections/${collectionId}/items/${itemId}/live`, {
      method: 'PATCH',
      body: { fieldData },
    });
  }

  /** Patch an item that isn't published yet. */
  async updateDraftItem(collectionId, itemId, fieldData) {
    return this.#request(`/collections/${collectionId}/items/${itemId}`, {
      method: 'PATCH',
      body: { fieldData },
    });
  }
}
