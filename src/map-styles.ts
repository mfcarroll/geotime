// src/map-styles.ts

export const worldTimezoneMapStyles: google.maps.MapTypeStyle[] = [
  {
    elementType: 'geometry',
    stylers: [{ color: '#3b4a5a' }],
  },
  {
    // Labels on this map are server-rendered into the tiles, so their legibility
    // is entirely a matter of contrast — there is no subpixel trick to fall back
    // on. #8a99a8 gave 3.1:1 against the land, which reads as soft rather than
    // sharp at any resolution; this is 7.2:1.
    elementType: 'labels.text.fill',
    stylers: [{ color: '#dce6f0' }],
  },
  {
    // The halo was #3b4a5a — the same colour as the land, so a 1:1 ratio and no
    // halo at all. Every label was floating unaided on a mid-tone ground, which
    // is most of why the map looked blurry when it was in fact pixel-sharp.
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#16202b' }],
  },
  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#4a6078' }],
  },
  {
    featureType: 'administrative.locality',
    stylers: [{ visibility: 'on' }],
  },
  {
    featureType: 'administrative.land_parcel',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'administrative.neighborhood',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'landscape.man_made',
    stylers: [{ visibility: 'off' }],
  },  
  {
    featureType: 'poi',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#4a6078' }], 
  },
  {
    featureType: 'road',
    elementType: 'labels',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'transit',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#1d2c3a' }], 
  },
];

export const locationMapStyles: google.maps.MapTypeStyle[] = [
  {
    elementType: 'geometry',
    stylers: [{ color: '#3b4a5a' }],
  },
  {
    // Labels on this map are server-rendered into the tiles, so their legibility
    // is entirely a matter of contrast — there is no subpixel trick to fall back
    // on. #8a99a8 gave 3.1:1 against the land, which reads as soft rather than
    // sharp at any resolution; this is 7.2:1.
    elementType: 'labels.text.fill',
    stylers: [{ color: '#dce6f0' }],
  },
  {
    // The halo was #3b4a5a — the same colour as the land, so a 1:1 ratio and no
    // halo at all. Every label was floating unaided on a mid-tone ground, which
    // is most of why the map looked blurry when it was in fact pixel-sharp.
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#16202b' }],
  },
  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#4a6078' }],
  },
  {
    featureType: 'administrative.land_parcel',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'poi',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'road',
    elementType: 'geometry',
    stylers: [{ color: '#4a6078' }], 
  },
  {
    featureType: 'road',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#212a37' }],
  },
  {
    featureType: 'road',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#c3d0dd' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry',
    stylers: [{ color: '#5e7a96' }], 
  },
  {
    featureType: 'road.highway',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#3b4a5a' }],
  },
  {
    featureType: 'road.highway',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#b0c4de' }],
  },
  {
    featureType: 'transit',
    stylers: [{ visibility: 'off' }],
  },
  {
    featureType: 'water',
    elementType: 'geometry',
    stylers: [{ color: '#1d2c3a' }], 
  },
];
