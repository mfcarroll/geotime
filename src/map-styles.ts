// src/map-styles.ts
//
// NOT APPLIED AT RUNTIME. The maps are cloud-styled vector maps now, and the
// Maps API ignores inline `styles` whenever a Map ID is present — see
// renderingOptions() in map.ts.
//
// Kept because these arrays are what was imported into the Cloud console styles
// behind those Map IDs, and they are the only copy under source control.
// Reconstructing the palette from the console is far harder than reading it
// here. They are also still the fallback if a Map ID is ever unset, which is the
// documented way back to the raster path.
//
// Change them and nothing happens until the cloud style is updated to match.

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
