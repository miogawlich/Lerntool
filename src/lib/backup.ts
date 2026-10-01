import { base64ToBlob, blobToBase64, db as defaultDb, type LernDB } from "./db";

const VERSION = 1;

/** Exportiert alle Daten (inkl. PDFs und Handschrift-Bilder) als JSON. API-Keys werden NICHT exportiert. */
export async function exportAll(database: LernDB = defaultDb): Promise<string> {
  const [courses, documents, topics, items, attempts, usage] = await Promise.all([
    database.courses.toArray(),
    database.documents.toArray(),
    database.topics.toArray(),
    database.items.toArray(),
    database.attempts.toArray(),
    database.usage.toArray(),
  ]);
  const docs = await Promise.all(
    documents.map(async (d) => ({ ...d, blob: { type: d.blob.type || "application/pdf", b64: await blobToBase64(d.blob) } })),
  );
  const atts = await Promise.all(
    attempts.map(async (a) => ({
      ...a,
      answerImage: a.answerImage ? { type: a.answerImage.type || "image/png", b64: await blobToBase64(a.answerImage) } : undefined,
    })),
  );
  return JSON.stringify({ app: "lerntool", version: VERSION, exportedAt: Date.now(), courses, documents: docs, topics, items, attempts: atts, usage });
}

type Encoded = { type: string; b64: string };

/** Importiert ein Backup. Bestehende Einträge mit gleicher ID werden überschrieben. */
export async function importAll(json: string, database: LernDB = defaultDb) {
  const data = JSON.parse(json);
  if (data?.app !== "lerntool") throw new Error("Das ist keine Lerntool-Sicherung.");
  const documents = (data.documents ?? []).map((d: { blob: Encoded }) => ({ ...d, blob: base64ToBlob(d.blob.b64, d.blob.type) }));
  const attempts = (data.attempts ?? []).map((a: { answerImage?: Encoded }) => ({
    ...a,
    answerImage: a.answerImage ? base64ToBlob(a.answerImage.b64, a.answerImage.type) : undefined,
  }));
  await database.transaction(
    "rw",
    [database.courses, database.documents, database.topics, database.items, database.attempts, database.usage],
    async () => {
      await database.courses.bulkPut(data.courses ?? []);
      await database.documents.bulkPut(documents);
      await database.topics.bulkPut(data.topics ?? []);
      await database.items.bulkPut(data.items ?? []);
      await database.attempts.bulkPut(attempts);
      await database.usage.bulkPut(data.usage ?? []);
    },
  );
  return { courses: (data.courses ?? []).length, items: (data.items ?? []).length };
}
