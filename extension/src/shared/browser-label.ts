/** "Chrome 130", "Microsoft Edge 130", "Brave 1.70"... for the portal's browser list. */
export function browserLabel(uaData: any): string {
  const brand = uaData?.brands?.find((b: any) => !/not.?a.?brand|chromium/i.test(b.brand));
  return brand ? `${brand.brand} ${brand.version}` : 'Chromium';
}
