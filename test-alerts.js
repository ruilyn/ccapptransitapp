const GtfsRealtimeBindings = require('gtfs-realtime-bindings');

async function test() {
  const url = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts';
  const response = await fetch(url, { headers: { accept: 'application/x-protobuf' } });
  if (!response.ok) {
    console.log("Failed", response.status);
    // try another one
    const url2 = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts.json';
    const response2 = await fetch(url2);
    console.log("JSON response:", await response2.text());
    return;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(buffer);
  console.log("Entities:", feed.entity.length);
  const first = feed.entity[0];
  if (first && first.alert) {
      console.log("First alert:", first.alert.headerText);
  }
}
test();
