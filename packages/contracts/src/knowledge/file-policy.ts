export const MAX_LOCAL_IMPORT_FILES = 5;
export const MAX_KNOWLEDGE_FILE_BYTES = 50 * 1024 * 1024;

export const DOCUMENT_FILE_EXTENSIONS = [
  '.txt',
  '.docx',
  '.docm',
  '.csv',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.pdf',
  '.md',
  '.html',
  '.pptx',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.ofd',
  '.doc',
  '.wps',
  '.ppt',
  '.pps',
  '.pot',
  '.xls',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.epub',
] as const;

export type DocumentFileExtension = (typeof DOCUMENT_FILE_EXTENSIONS)[number];

const commonOfficeMimes = ['application/octet-stream'] as const;

export const DOCUMENT_MIME_BY_EXTENSION: Readonly<
  Record<DocumentFileExtension, readonly string[]>
> = {
  '.txt': ['text/plain'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.docm': ['application/vnd.ms-word.document.macroEnabled.12'],
  '.csv': ['text/csv', 'application/csv'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xlsm': ['application/vnd.ms-excel.sheet.macroEnabled.12'],
  '.xlsb': ['application/vnd.ms-excel.sheet.binary.macroEnabled.12'],
  '.pdf': ['application/pdf'],
  '.md': ['text/markdown', 'text/x-markdown', 'text/plain'],
  '.html': ['text/html', 'application/xhtml+xml'],
  '.pptx': ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  '.pptm': ['application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
  '.ppsx': ['application/vnd.openxmlformats-officedocument.presentationml.slideshow'],
  '.ppsm': ['application/vnd.ms-powerpoint.slideshow.macroEnabled.12'],
  '.ofd': ['application/ofd', 'application/ofd+xml', 'application/zip'],
  '.doc': ['application/msword', ...commonOfficeMimes],
  '.wps': [
    'application/vnd.ms-works',
    'application/wps-office.wps',
    'application/x-wps',
    'application/msword',
    ...commonOfficeMimes,
  ],
  '.ppt': ['application/vnd.ms-powerpoint', ...commonOfficeMimes],
  '.pps': ['application/vnd.ms-powerpoint', ...commonOfficeMimes],
  '.pot': ['application/vnd.ms-powerpoint', ...commonOfficeMimes],
  '.xls': ['application/vnd.ms-excel', ...commonOfficeMimes],
  '.odt': ['application/vnd.oasis.opendocument.text'],
  '.ods': ['application/vnd.oasis.opendocument.spreadsheet'],
  '.odp': ['application/vnd.oasis.opendocument.presentation'],
  '.rtf': ['application/rtf', 'text/rtf'],
  '.epub': ['application/epub+zip'],
};

export const DOCUMENT_ACCEPT = DOCUMENT_FILE_EXTENSIONS.join(',');

export function isDocumentFileExtension(value: string): value is DocumentFileExtension {
  return (DOCUMENT_FILE_EXTENSIONS as readonly string[]).includes(value.toLowerCase());
}
