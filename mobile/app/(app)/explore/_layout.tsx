// The explore layout — where the map is DRAWN.
//
// ARCHITECTURE V2, PRINCIPLE 0.2: the map is the operating system of Luul Scan.
// Every workflow begins and ends on the live map, and no navigation may unmount
// the map, the exploration session or the GPS watch.
//
// The session and the workspace state used to be mounted HERE, which honoured
// that principle only while the geologist stayed on the route. The back arrow
// popped it, React unmounted the provider, and the provider's teardown ended the
// expedition and stopped the GPS watch — because somebody wanted to look at
// their collection for ten seconds. They now live in the ROOT layout
// (app/_layout.tsx), for the life of the app process.
//
// What is left here is the map SURFACE and the router's children on top of it.
// Leaving this route stops drawing the canvas; it stops nothing else. Coming back
// restores the same camera over the same scene, because neither was ever lost.
//
// `<Slot/>` rather than a nested `<Stack/>` is deliberate. A stack would paint
// its own opaque background over the map — the very thing this layout exists to
// prevent — and a workspace does not want push/pop chrome between its surfaces.
// Routes still exist and still deep-link.
import React from "react";
import { Slot } from "expo-router";
import { MapWorkspace } from "../../../components/MapWorkspace";

export default function ExploreLayout() {
  return (
    <MapWorkspace>
      <Slot />
    </MapWorkspace>
  );
}
