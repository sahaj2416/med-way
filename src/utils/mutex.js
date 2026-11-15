class AsyncMutex {
  constructor() {
    this._queue = Promise.resolve();
  }

  runExclusive(task) {
    const next = this._queue.then(() => task());
    this._queue = next.catch(() => {});
    return next;
  }
}

const dispatchMutex = new AsyncMutex();

module.exports = {
  AsyncMutex,
  dispatchMutex
};
