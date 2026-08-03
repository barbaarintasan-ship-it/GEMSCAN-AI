// H3 indexing constant — shared by both runtimes.
//
// The RESOLUTION is parity-critical: server and device must bucket to the same
// cells, or the same position produces two different cache/index keys and the
// E3 comparison is meaningless. So the constant lives here, in the one module
// both runtimes import.
//
// The h3-js BINDING is not shared: Deno loads it from esm.sh, React Native from
// node_modules. Both are pinned to h3-js 4.1.0, so latLngToCell agrees. This is
// the same adapter split used for the data gateway — shared contract, per-runtime
// transport.

/** ~5.16 km² hexagons — regional geological context (Architecture §7.2). */
export const H3_RESOLUTION = 7;
