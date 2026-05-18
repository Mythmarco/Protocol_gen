# Google Drive setup

⚠️ **Importante**: La carpeta donde se guardan los PDFs DEBE estar dentro de un **Shared Drive** (Unidad compartida), no en "Mi unidad" personal. Esto es por una restricción de Google: los service accounts no tienen quota de storage propia, así que no pueden poseer archivos en Drives personales.

---

## 1. Crear (o usar) un Shared Drive

1. Ve a [drive.google.com](https://drive.google.com) con tu cuenta de Workspace
2. En el menú lateral izquierdo: **Shared drives** (Unidades compartidas) → **+ New** (Nueva)
3. Nombre sugerido: `Peptides4ALL — Protocolos`
4. Click **Create**

## 2. Compartir el Shared Drive con el service account

1. Click derecho en el Shared Drive → **Manage members**
2. Pega el `client_email` del service account (`peptides-4all@peptides4all.iam.gserviceaccount.com`)
3. Permiso: **Content manager** (o **Manager** si quieres que pueda crear/borrar carpetas)
4. **Share**

## 3. Crear la carpeta raíz dentro del Shared Drive

1. Entra al Shared Drive
2. Click derecho en el panel principal → **New folder** → nombre: `Protocolos generados` (o el que prefieras)
3. Abre la carpeta y **copia el ID del URL**: en `https://drive.google.com/drive/folders/XYZ123abc`, el ID es `XYZ123abc`

## 4. Configurar `.env.local`

Pega el ID en `.env.local`:

```env
GOOGLE_DRIVE_FOLDER_ID=XYZ123abc   ← el ID de la carpeta del Shared Drive
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

## 5. Reiniciar el dev server

```bash
cd protocol-gen
npm run dev
```

## 6. Verificar

Genera un protocolo. En la terminal deberías ver:
```
[pdf] uploaded to Drive: https://drive.google.com/file/d/.../view
[pdf] saved to Supabase for ...
```

Y en el Shared Drive verás una subcarpeta con el nombre del paciente, con el PDF dentro.

---

## Crear el service account (si aún no lo tienes)

1. [Google Cloud Console](https://console.cloud.google.com/) → IAM & Admin → Service Accounts
2. Create Service Account → nombre cualquiera
3. Skip roles, click Done
4. Click en el SA recién creado → KEYS → Add Key → Create new key → JSON
5. Se descarga el JSON. Cópialo entero como una sola línea (`cat archivo.json | jq -c .`) y pégalo en `.env.local` como `GOOGLE_SERVICE_ACCOUNT_JSON=...`
6. También habilita la **Google Drive API** y la **Google Sheets API** en APIs & Services → Library

---

## Troubleshooting

**"Service Accounts do not have storage quota"** → la carpeta NO está en un Shared Drive. Es el bug clásico. Sigue los pasos arriba para crear un Shared Drive y mover/recrear la carpeta ahí.

**"File not found" / "insufficient permissions"** → el SA no es miembro del Shared Drive. Re-añade el `client_email` con permiso Content Manager.

**"Google Sheets API has not been used"** → habilita esa API también en Google Cloud Console.
