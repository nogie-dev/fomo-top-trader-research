import type { CheckpointStore } from "../shared/analysis-control";

let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("wallet-research-checkpoints", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("entries", { keyPath: ["analysisId", "key"] });
      store.createIndex("analysisId", "analysisId");
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
    request.onerror = () => { database = undefined; reject(request.error ?? new Error("중간 저장소를 열지 못했습니다.")); };
    request.onblocked = () => { database = undefined; reject(new Error("다른 결과 탭을 닫고 다시 시도해 주세요.")); };
  });
}

export const checkpointStore: CheckpointStore = {
  async read<T>(analysisId: string, key: string): Promise<T | undefined> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("entries", "readonly");
      const request = transaction.objectStore("entries").get([analysisId, key]);
      let value: T | undefined;
      request.onsuccess = () => { value = request.result?.value as T | undefined; };
      transaction.oncomplete = () => resolve(value);
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("중간 저장 데이터를 읽지 못했습니다."));
    });
  },
  async write(analysisId, entries) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("entries", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("중간 데이터를 저장하지 못했습니다."));
      try { for (const { key, value } of entries) transaction.objectStore("entries").put({ analysisId, key, value }); }
      catch (error) { transaction.abort(); reject(error); }
    });
  },
  async clear(analysisId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("entries", "readwrite");
      const store = transaction.objectStore("entries");
      const request = store.index("analysisId").openKeyCursor(IDBKeyRange.only(analysisId));
      request.onsuccess = () => { const cursor = request.result; if (cursor) { store.delete(cursor.primaryKey); cursor.continue(); } };
      transaction.oncomplete = () => resolve();
      transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("중간 데이터를 삭제하지 못했습니다."));
    });
  },
};
