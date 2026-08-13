// Compatibility route: /(app)/exploration → /(app)/explore
//
// The exploration screen became a layout that hosts the map (see
// app/(app)/explore/_layout.tsx). This route stays because other things still
// point at the old path and must keep working:
//
//   • the home screen's Exploration button on installed builds,
//   • the capture screen's return path on any build older than this one,
//   • any deep link already in the wild.
//
// Parameters are forwarded, so `?analysed=<id>` still reaches the surface that
// folds a finished sample back into the running session.
import React from "react";
import { Redirect, useLocalSearchParams } from "expo-router";

export default function ExplorationCompatRoute() {
  const params = useLocalSearchParams<{ analysed?: string }>();
  return <Redirect href={{ pathname: "/(app)/explore", params }} />;
}
