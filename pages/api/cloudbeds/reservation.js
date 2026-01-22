// pages/api/cloudbeds/reservation.js
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  // 1. Get stored access token from cloudbeds_tokens table
  // 2. Call Cloudbeds getReservation API
  // 3. Extract roomName from assigned[] array
  // 4. Call Cloudbeds Door Lock Keys API to get access code
  // 5. Return { roomName, accessCode }
}
