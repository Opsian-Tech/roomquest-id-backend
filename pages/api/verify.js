fetch("https://roomquest-id-visitor-flow.vercel.app/api/verify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    action: "start",
    flow_type: "guest"
  })
})
.then(r => r.json())
.then(async (start) => {
  console.log("START:", start);

  const session_token = start.session_token;

  const upd = await fetch("https://roomquest-id-visitor-flow.vercel.app/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "update_guest",
      session_token,
      guest_name: "Jesse Noe",
      booking_ref: "1982021647"
    })
  }).then(r => r.json());

  console.log("UPDATE_GUEST:", upd);

  const sess = await fetch("https://roomquest-id-visitor-flow.vercel.app/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "get_session",
      session_token
    })
  }).then(r => r.json());

  console.log("GET_SESSION:", sess);
});
