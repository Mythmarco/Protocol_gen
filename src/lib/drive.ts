import { Readable } from "node:stream";
import { getDriveClient, hasGoogleAuth } from "./google-auth";

// Google Drive upload via service account. Uses the shared google-auth helper.
// IMPORTANT: GOOGLE_DRIVE_FOLDER_ID must point to a folder inside a
// SHARED DRIVE (Team Drive). Service accounts cannot own files in personal
// "My Drive" because they don't have storage quota.

export function isDriveConfigured(): boolean {
  return hasGoogleAuth() && Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID);
}

// Find or create a per-patient subfolder under the root folder.
async function getPatientFolderId(patientName: string): Promise<string> {
  const drive = getDriveClient();
  const rootId = process.env.GOOGLE_DRIVE_FOLDER_ID!;
  const safeName = patientName.replace(/'/g, "\\'").trim();

  const search = await drive.files.list({
    q: `'${rootId}' in parents and name = '${safeName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id, name)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  });

  if (search.data.files && search.data.files.length > 0) {
    return search.data.files[0].id!;
  }

  const created = await drive.files.create({
    requestBody: {
      name: safeName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  return created.data.id!;
}

export async function uploadPDFToDrive(args: {
  fileName: string;
  pdfBuffer: Buffer;
  patientName: string;
}): Promise<string> {
  const drive = getDriveClient();
  const folderId = await getPatientFolderId(args.patientName);

  const res = await drive.files.create({
    requestBody: {
      name: args.fileName,
      parents: [folderId],
      mimeType: "application/pdf",
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(args.pdfBuffer),
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  return res.data.webViewLink ?? `https://drive.google.com/file/d/${res.data.id}/view`;
}
