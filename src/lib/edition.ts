declare const __APP_EDITION__: string;
declare const __APP_NAME__: string;

/** 'alpha' | 'stable' */
export const APP_EDITION: string = __APP_EDITION__;
/** 'ClaudeDeck Alpha' | 'ClaudeDeck' */
export const APP_NAME: string = __APP_NAME__;
export const IS_ALPHA = APP_EDITION === 'alpha';
