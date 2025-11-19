import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { data } = await supabase
      .from('demo_sessions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20);
    
    return res.json(data || []);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
