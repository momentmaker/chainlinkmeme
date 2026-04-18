// Ported verbatim from chainlink-meme-api/app/models/tag.rb
// `synonyms` = strict rewrite: a user-typed tag gets replaced by the canonical value(s)
// `related` = expansion: when these tags are present, also match these other tags

export const synonyms: Record<string, string[]> = {
  biz: ['4chan'],
  '/biz/': ['4chan'],
  '77': ['7777777'],
  '777': ['7777777', '777'],
  based: ['sergey', 'chad', 'linkpilled'],
  linkie: ['linkmarines', 'linkie'],
  linkies: ['linkmarines', 'linkie'],
  flannelman: ['plaidshirt'],
  plaid: ['plaidshirt'],
  swingie: ['swinglinkers'],
  swingies: ['swinglinkers'],
  swinglinker: ['swinglinkers'],
  nolinker: ['nolinkers'],
  mcd: ['bigmac', 'mcd'],
  mcdonald: ['bigmac', 'mcd'],
  whatwasthat: ['wtfwasthat'],
  wwt: ['wtfwasthat'],
  wtfwt: ['wtfwasthat'],
};

export const related: Record<string, string[]> = {
  '7777777': ['42', 'mememagic'],
  '42': ['7777777', 'mememagic'],
  mememagic: ['42', '7777777'],
  chess: ['4dchess'],
  '4dchess': ['chess'],
  prophecy: ['sage'],
  bull: ['greendildo'],
  greendildo: ['bull'],
  fundamentally: ['vertical', '4ir'],
  vertical: ['fundamentally', '4ir'],
  notselling: ['drns'],
  drns: ['notselling'],
  peepeepoopoo: ['nopants'],
  nopants: ['peepeepoopoo'],
  swinglinkers: ['nolinkers', 'rope'],
  rope: ['nolinkers', 'swinglinkers'],
  nolinkers: ['rope', 'swinglinkers'],
  magicbus: ['4ir'],
  allinthistogether: ['positivethought', 'weareallinthistogether'],
  positivethought: ['allinthistogether', 'weareallinthistogether'],
  winning: ['youjustwin'],
  youjustwin: ['winning'],
};
