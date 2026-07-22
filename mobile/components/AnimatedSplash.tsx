// AnimatedSplash
//
// The animated boot logo shown once, right after the (brief) native splash and
// before the app UI. It renders the approved blue-diamond animation: the gem
// pops in facet by facet, corner brackets draw, a scan line sweeps, a bright
// glint streaks across the stone, sparkles twinkle, and the "LuulScan" wordmark
// reveals with a gold shimmer on "Luul" and a blue "Scan".
//
// Implementation note: the app intentionally has NO react-native-svg /
// reanimated / lottie / expo-splash-screen dependency (keeps the native build
// lean and the "no billing SDK" policy simple). Instead we reuse the already
// bundled react-native-webview to render the exact HTML/CSS/SVG animation the
// design was approved from — pixel-for-pixel, zero new native modules. The RN
// side only owns how long it stays on screen and the fade-out.
import React, { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

// Dark blue-black backdrop — matches the HTML body background exactly so there
// is never a colour seam between the RN container and the WebView content.
const BACKDROP = "#080C14";

// Self-contained animation document. No external fonts/assets so it paints
// instantly inside the WebView. The SVG geometry is the same brilliant cut used
// by assets/logo.svg, recoloured blue.
const SPLASH_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"/>
<style>
  html,body{margin:0;height:100%;background:${BACKDROP};overflow:hidden}
  .stage{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;
    font-family:-apple-system,Roboto,"Segoe UI",system-ui,sans-serif}
  svg{overflow:visible}
  /* whole gem gently pops in */
  .gem{transform-box:fill-box;transform-origin:center;animation:gemPop .8s cubic-bezier(.2,.85,.25,1) forwards}
  .facet{opacity:0;animation:facetIn .6s ease forwards}
  .f1{animation-delay:.08s}.f2{animation-delay:.15s}.f3{animation-delay:.22s}
  .f4{animation-delay:.29s}.f5{animation-delay:.37s}.f6{animation-delay:.45s}
  .bracket{stroke-dasharray:160;stroke-dashoffset:160;animation:draw .5s ease forwards;animation-delay:.15s}
  .scan{opacity:0;animation:scanSweep 1.8s ease-in-out .8s infinite}
  .glow{transform-box:fill-box;transform-origin:center;animation:pulse 2.4s ease-in-out .6s infinite}
  .glint{opacity:0;animation:glintSweep 2.6s ease-in-out 1s infinite}
  .spark{transform-box:fill-box;transform-origin:center;opacity:0;animation:twinkle 2.1s ease-in-out infinite}
  .s1{animation-delay:.95s}.s2{animation-delay:1.35s}.s3{animation-delay:1.15s}.s4{animation-delay:1.6s}
  .word{font-size:34px;font-weight:600;letter-spacing:2px;opacity:0;
    animation:wordIn .8s cubic-bezier(.2,.8,.2,1) forwards;animation-delay:.8s;display:flex}
  .luul{
    background:linear-gradient(100deg,#8A6A1E 0%,#D9B23B 18%,#FFF3C9 42%,#FDF0B8 50%,#FFF3C9 58%,#D9B23B 82%,#8A6A1E 100%);
    background-size:250% 100%;
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;
    animation:shimmer 2.4s linear 1.1s infinite;
  }
  .scanw{color:#3AA0E8}
  .sub{font-size:13px;opacity:0;text-align:center;max-width:300px;line-height:1.5;padding:0 16px;
    background:linear-gradient(90deg,#3AA0E8 0%,#7CC6F5 12%,#F4D77A 26%,#FFF3C9 34%,#D9B23B 44%,#7CC6F5 60%,#3AA0E8 70%,#F4D77A 86%,#D9B23B 96%,#3AA0E8 100%);
    background-size:200% 100%;
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;
    animation:wordIn .9s ease 1.1s forwards, subShift 5s linear 1.1s infinite}
  @keyframes gemPop{0%{transform:scale(.82)}100%{transform:scale(1)}}
  @keyframes facetIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
  @keyframes draw{to{stroke-dashoffset:0}}
  @keyframes scanSweep{0%{opacity:0;transform:translateY(-150px)}18%{opacity:.9}80%{opacity:.9}100%{opacity:0;transform:translateY(150px)}}
  @keyframes pulse{0%,100%{opacity:.22;transform:scale(.9)}50%{opacity:.5;transform:scale(1.06)}}
  @keyframes glintSweep{0%{opacity:0;transform:skewX(-16deg) translateX(-520px)}
    12%{opacity:.85}30%{opacity:.85;transform:skewX(-16deg) translateX(560px)}
    40%{opacity:0;transform:skewX(-16deg) translateX(640px)}100%{opacity:0;transform:skewX(-16deg) translateX(640px)}}
  @keyframes twinkle{0%,100%{opacity:0;transform:scale(.3) rotate(0deg)}
    50%{opacity:.95;transform:scale(1) rotate(45deg)}}
  @keyframes wordIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
  @keyframes shimmer{0%{background-position:180% 0}100%{background-position:-80% 0}}
  @keyframes subShift{0%{background-position:200% 0}100%{background-position:-200% 0}}
</style>
</head>
<body>
<div class="stage">
  <svg width="232" height="232" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bl" x1="512" y1="300" x2="512" y2="760" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#8FD8FF"/><stop offset="0.5" stop-color="#3AA0E8"/><stop offset="1" stop-color="#1B62B4"/></linearGradient>
      <linearGradient id="lt" x1="380" y1="320" x2="560" y2="520" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#DFF4FF"/><stop offset="1" stop-color="#7CC6F5"/></linearGradient>
      <radialGradient id="gl" cx="512" cy="500" r="360" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3AA0E8" stop-opacity="0.55"/><stop offset="1" stop-color="#3AA0E8" stop-opacity="0"/></radialGradient>
      <linearGradient id="glintgrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.78"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <clipPath id="scanclip"><rect x="200" y="230" width="624" height="580"/></clipPath>
      <clipPath id="gemhull"><path d="M336 372 L688 372 L744 452 L512 792 L280 452 Z"/></clipPath>
    </defs>

    <circle class="glow" cx="512" cy="500" r="360" fill="url(#gl)"/>

    <g class="gem">
      <g stroke="#080C14" stroke-width="6" stroke-linejoin="round">
        <path class="facet f1" d="M280 452 L512 792 L744 452 Z" fill="url(#bl)"/>
        <path class="facet f2" d="M280 452 L392 452 L336 372 Z" fill="url(#bl)"/>
        <path class="facet f2" d="M392 452 L512 452 L456 372 Z" fill="url(#lt)"/>
        <path class="facet f3" d="M512 452 L632 452 L568 372 Z" fill="url(#bl)"/>
        <path class="facet f3" d="M632 452 L744 452 L688 372 Z" fill="url(#lt)"/>
        <path class="facet f4" d="M336 372 L456 372 L392 452 L280 452 Z" fill="url(#lt)"/>
        <path class="facet f4" d="M456 372 L568 372 L512 452 L392 452 Z" fill="url(#bl)"/>
        <path class="facet f4" d="M568 372 L688 372 L744 452 L632 452 Z" fill="url(#lt)"/>
        <path class="facet f5" d="M280 452 L392 452 L512 792 Z" fill="url(#bl)"/>
        <path class="facet f5" d="M392 452 L512 452 L512 792 Z" fill="url(#lt)"/>
        <path class="facet f6" d="M512 452 L632 452 L512 792 Z" fill="url(#bl)"/>
        <path class="facet f6" d="M632 452 L744 452 L512 792 Z" fill="url(#lt)"/>
      </g>

      <g clip-path="url(#gemhull)">
        <rect class="glint" x="340" y="-140" width="150" height="1300" fill="url(#glintgrad)"/>
      </g>

      <g clip-path="url(#scanclip)">
        <line class="scan" x1="232" y1="510" x2="792" y2="510" stroke="#DFF4FF" stroke-width="10" stroke-linecap="round"/>
      </g>
    </g>

    <g stroke="#3AA0E8" stroke-width="16" stroke-linecap="round" fill="none">
      <path class="bracket" d="M232 300 L232 250 L282 250"/><path class="bracket" d="M792 300 L792 250 L742 250"/>
      <path class="bracket" d="M232 700 L232 750 L282 750"/><path class="bracket" d="M792 700 L792 750 L742 750"/>
    </g>

    <g fill="#EAF6FF">
      <path class="spark s1" d="M726 330 L734 356 L760 364 L734 372 L726 398 L718 372 L692 364 L718 356 Z"/>
      <path class="spark s2" d="M300 556 L306 574 L324 580 L306 586 L300 604 L294 586 L276 580 L294 574 Z"/>
      <path class="spark s3" d="M470 296 L475 311 L490 316 L475 321 L470 336 L465 321 L450 316 L465 311 Z"/>
      <path class="spark s4" d="M712 648 L717 663 L732 668 L717 673 L712 688 L707 673 L692 668 L707 663 Z"/>
    </g>
  </svg>

  <div class="word"><span class="luul">Luul</span><span class="scanw">Scan</span></div>
  <div class="sub">Gems &middot; minerals &middot; crystals &middot; coins &middot; artifacts &middot; gold &amp; precious metals</div>
</div>
</body>
</html>`;

type Props = {
  onFinish?: () => void;
  // How long the animation is visible before it fades out (ms). Long enough to
  // read the wordmark and the subtitle line comfortably.
  duration?: number;
};

export function AnimatedSplash({ onFinish, duration = 3600 }: Props) {
  const opacity = useRef(new Animated.Value(1)).current;
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 480,
        useNativeDriver: true,
      }).start(() => {
        setHidden(true);
        onFinish?.();
      });
    }, duration);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (hidden) return null;

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.container, { opacity }]} pointerEvents="none">
      <WebView
        source={{ html: SPLASH_HTML }}
        // The WebView background matches our container backdrop, so there is no
        // white flash before the document's own background renders.
        style={styles.webview}
        originWhitelist={["*"]}
        scrollEnabled={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        androidLayerType="hardware"
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: BACKDROP,
    zIndex: 999,
  },
  webview: {
    flex: 1,
    backgroundColor: BACKDROP,
  },
});
