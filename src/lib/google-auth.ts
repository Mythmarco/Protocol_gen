import { google } from "googleapis";

// Single shared GoogleAuth setup for the service account.
// Used by both Drive (uploads) and Sheets (reading the price catalog).

export function hasGoogleAuth(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "{}");
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/spreadsheets.readonly",
    ],
  });
}

export function getDriveClient() {
  return google.drive({ version: "v3", auth: getAuth() });
}

export function getSheetsClient() {
  return google.sheets({ version: "v4", auth: getAuth() });
}
