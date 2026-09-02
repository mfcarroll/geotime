// src/map-styles.ts
//
// NOT APPLIED AT RUNTIME. The maps are cloud-styled vector maps now, and the
// Maps API ignores inline `styles` whenever a Map ID is present — see
// renderingOptions() in map.ts.
//
// No longer the source of truth for the palette either. These arrays seeded the
// cloud styles originally, but the style has since been edited in the console
// and exported to docs/map-styles/google-maps-styles.json — which is the tracked
// copy, is in the format the console actually imports, and is what these have
// drifted from.
//
// Kept only as the fallback for the path where a Map ID is unset, which is the
// documented way back to raster. Read them as an old raster palette, not as a
// description of what the maps look like today.

export const worldTimezoneMapStyles: google.maps.MapTypeStyle[] = [
  {
    elementType: 'geometry',
    stylers: [{ color: '#3b4a5a' }],
  },
  {
    elementType: 'labels.text.fill',
    stylers: [{ color: '#8a99a8' }], 
  },
  {
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#3b4a5a' }],
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
    elementType: 'labels.text.fill',
    stylers: [{ color: '#8a99a8' }], 
  },
  {
    elementType: 'labels.text.stroke',
    stylers: [{ color: '#3b4a5a' }],
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
    stylers: [{ color: '#8a99a8' }],
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
