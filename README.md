# ServiceNow Background Exporter

A browser extension for exporting ServiceNow table data through native background export jobs using your existing session.

Split a filtered list into chunks, run jobs concurrently, and download the results as CSV, XLSX, XML, or JSON. CSV files can be combined into a single download. Export history keeps batches available for downloading or rerunning.

## Usage

Open a classic ServiceNow list and click the extension button. Configure the export, review the settings, and confirm to start.

## Development

Requires Node.js 22.12+ and npm. Node.js 24 is recommended.

```sh
npm ci
npm run check
npm run check:browser
```

## Integration

Uses the processor behind ServiceNow’s native export functionality and the client-side GlideRecord API for other data access.
