/* Pier's logo geometry, copied from the brand kit (Pier_Marca v2, 02_Logo/SVG_editable). The
   symbol is a «P» shaped like a pier: a firm pillar and a bowl split in two halves (par-A with
   the pillar, par-B the lower half), drawn as strokes. The wordmark sets the same P before «ier»
   and the dot of the i. Coordinates are the kit's; `box` crops each to its ink. */
export const LOGO = {
  /** The symbol alone (the P). */
  mark: {
    box: [219, 219, 240, 292] as const,
    stroke: 56,
    pA: 'M247 511V247H363.96A67.04 67.04 0 0 1 431 314.04',
    pB: 'M431 334.2A67.04 67.04 0 0 1 363.96 401.24H295.16',
  },
  /** The wordmark: the P, «ier» and the dot of the i. */
  wordmark: {
    box: [219, 207, 812, 312] as const,
    ier: 'M533 511V335.4H502.6V293.8H588.6V511ZM749.8 518.6Q721.8 518.6 700.8 509Q679.8 499.4 666 483.2Q652.2 467 645.2 447Q638.2 427 638.2 406.2V398.6Q638.2 377 645.2 356.8Q652.2 336.6 666 320.8Q679.8 305 700.2 295.6Q720.6 286.2 747.4 286.2Q782.6 286.2 806.4 301.6Q830.2 317 842.2 342Q854.2 367 854.2 395.8V415.8H691Q692.2 428.2 696.6 438.6Q703 454.6 716.2 463.6Q729.4 472.6 749.8 472.6Q770.2 472.6 783 464.4Q795.8 456.2 799.4 444.2H850.6Q845.8 466.6 832.2 483.4Q818.6 500.2 797.6 509.4Q776.6 518.6 749.8 518.6ZM691.8 381.8H801Q799.8 371.4 796.2 363Q790.2 348.2 778 340.2Q765.8 332.2 747.4 332.2Q729 332.2 716.2 340.6Q703.4 349 697 364.6Q693.4 372.6 691.8 381.8ZM900.6 511V293.8H944.6V364.2Q948.2 333 963.4 315Q983.4 291 1022.2 291H1030.2V339.4H1015Q987 339.4 971.6 354.4Q956.2 369.4 956.2 397.8V511Z',
    dot: { cx: 560.8, cy: 241, r: 33.6 },
  },
} as const;
