/**
 * The editor URL for a document in a language. Always carries ?lang: a missing
 * one means the CONFIGURED default, so leaving it off "for English" sent
 * editors on a Norwegian-default instance into Norwegian on every click.
 */
export const editPath = (documentId: string, locale: string): string => `/edit/${documentId}?lang=${encodeURIComponent(locale)}`;
