// Phone breakpoint (spec §5.11). App keeps `store.mobile` in sync with it; components read the store, not the query.
export const MOBILE_QUERY = '(max-width: 760px)';
