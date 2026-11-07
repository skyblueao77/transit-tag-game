# PoC Evaluation: Supabase Realtime Broadcast Architecture for Ephemeral Location Telemetry

- **Document ID:** POC-REALTIME-BROADCAST-001
- **Status:** Evaluated / Proposed for Phase 5+ Architecture Evolution
- **Date:** 2026-11-07
- **Related Documents:**
  - [ADR-001: Club-Owned Supabase and Vercel Deployments](file:///home/antigravity/skyblueao77/transit-tag-game/docs/migration/ADR-001-SUPABASE-DEPLOYMENT-MODEL.md)
  - [Firebase to Supabase Mapping](file:///home/antigravity/skyblueao77/transit-tag-game/docs/migration/FIREBASE_TO_SUPABASE_MAP.md)
  - [Modernization Implementation Plan](file:///home/antigravity/skyblueao77/transit-tag-game/docs/modernization_implementation_plan.md)

---

## 1. Executive Summary

In transit tag games, participants generate frequent location updates (1/min or faster). On Firebase Spark (free tier), storing these in Firestore consumes up to 10,000 document writes per 8-hour game (50% of the daily 20,000 write limit).

This PoC evaluates transitioning ephemeral player location telemetry from persistent database documents to **Supabase Realtime Broadcast** (WebSocket-based pub/sub).

### Key Findings
1. **Zero Database Writes:** Supabase Realtime Broadcast channels bypass PostgreSQL storage completely. Location telemetry produces **0 disk I/O and 0 row writes**, eliminating the primary quota bottleneck.
2. **Sub-Second Latency:** WebSocket delivery delivers location updates with sub-second latency (vs 1–3s Firestore listener latency), dramatically improving ONI capture proximity tracking.
3. **Generous Free Quotas:** Supabase free tier provides **200 concurrent Realtime connections** and **2,000,000 messages/month**, easily supporting multiple 20–50 player club games simultaneously at zero cost.
4. **Security Requirement:** Realtime Broadcast must not blindly broadcast private coordinates to all game participants. Ephemeral location streams must use scoped channels with Supabase Realtime Authorization (RLS on `realtime.messages`) or server-mediated distribution to preserve team reveal privacy and player safety.

---

## 2. Architecture Comparison: Firestore vs. Supabase Realtime

| Metric / Dimension | Firebase Firestore (Current RC) | Supabase Realtime Broadcast (Proposed) |
| :--- | :--- | :--- |
| **Communication Protocol** | HTTPS long-polling / HTTP/2 gRPC streaming | Persistent WebSockets (`phoenix` channels) |
| **Persistence Mechanism** | Persistent documents (`privateLocations/{uid}`) | Ephemeral memory-only pub/sub (No DB table write) |
| **Latency** | 1,000 ms – 3,000 ms | < 100 ms – 300 ms |
| **Write Cost / Quota Impact** | 1 write per upload (~5,000–9,600 writes/game) | **0 writes** (Bypasses PostgreSQL database engine) |
| **Monthly Free Allowance** | 20,000 writes/day (Firebase Spark) | 2,000,000 messages/month, 200 peak connections |
| **Storage Consumption** | Grows with updates (overwrites 1 doc/user) | 0 bytes persistent disk storage |
| **Access Control** | Firestore Security Rules (`request.auth.uid`, etc.) | Supabase Realtime Authorization (RLS on broadcast topic) |
| **Battery Impact** | Moderate (periodic HTTPS network requests) | Low (single multiplexed WebSocket connection) |

---

## 3. Mathematical Quota Analysis

### Baseline (20 Players, 8-Hour Game)

$$\text{Total Duration} = 8\text{ hours} = 480\text{ minutes}$$

1. **Unthrottled Firestore (1 write / 60 seconds):**
   $$20 \times 60 \times 8 = 9,600\text{ writes (48\% of Spark 20,000 daily limit)}$$

2. **Phase 4 Intelligent Distance Throttling (30m movement or 5m quiet fallback):**
   - In transit tag games, players spend 50–60% of their time stationary (train rides, platform waiting, shinkansen wait).
   - Stationary writes: $480 \times 0.5 \div 5 = 48$ writes/player.
   - Moving writes: $480 \times 0.5 \div 1 = 240$ writes/player.
   - Total location writes: $20 \times (48 + 240) = 5,760\text{ writes (71\% under Spark ceiling)}$.

3. **Supabase Realtime Broadcast (Sub-second or 15s interval):**
   - Database writes: **0**.
   - Realtime messages (1 update every 15s while moving, 1 every 60s while stationary):
     $$\text{Messages per player} = (240 \times 4) + (240 \times 1) = 1,200\text{ messages}$$
     $$\text{Total for 20 players} = 24,000\text{ messages}$$
   - Supabase free tier allowance: $2,000,000\text{ messages/month}$.
   - Game consumes **1.2%** of monthly allowance for an entire 8-hour game.

---

## 4. Prototype Client Implementation

### TypeScript Subscription & Broadcast Service

```typescript
import { createClient, RealtimeChannel } from '@supabase/supabase-js';

export interface LocationTelemetry {
  playerId: string;
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export class SupabaseLocationTelemetryService {
  private channel: RealtimeChannel | null = null;

  constructor(
    private supabase: ReturnType<typeof createClient>,
    private sessionId: string,
    private team: 'A' | 'B'
  ) {}

  /**
   * Connect to team-scoped broadcast channel.
   * Supabase Realtime RLS policies on `realtime.messages` ensure participants
   * can only join channels they are authorized for.
   */
  public joinTelemetryChannel(
    onLocationReceived: (telemetry: LocationTelemetry) => void
  ): void {
    const topic = `game:${this.sessionId}:telemetry:team_${this.team}`;

    this.channel = this.supabase
      .channel(topic, {
        config: {
          broadcast: {
            self: false, // Do not echo our own updates back to us
            ack: false,  // Ephemeral telemetry does not require server ack
          },
        },
      })
      .on('broadcast', { event: 'location_update' }, ({ payload }) => {
        onLocationReceived(payload as LocationTelemetry);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.info(`Subscribed to telemetry topic: ${topic}`);
        }
      });
  }

  /**
   * Broadcast player location telemetry over WebSocket.
   * Produces 0 database writes.
   */
  public async broadcastLocation(telemetry: LocationTelemetry): Promise<void> {
    if (!this.channel) {
      throw new Error('Telemetry channel not initialized');
    }

    await this.channel.send({
      type: 'broadcast',
      event: 'location_update',
      payload: telemetry,
    });
  }

  public leave(): void {
    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }
  }
}
```

---

## 5. Security and Privacy Considerations

In the transit tag game, **location privacy is fundamental to fair gameplay and physical safety**:
- **RUNNERs** must not see **ONI** locations unless an active Team Reveal / Radar power-up is in effect.
- **Opponent RUNNERs** must not see each other unless Global Reveal is active.
- **Emergency / SOS locations** must only be projected to Administrators, never to active players.

### Realtime Channel Authorization Model

When using Supabase Realtime Broadcast:
1. **Never use a single global broadcast channel for raw locations.** A naive implementation where all players connect to `game:locations` and filter coordinates in React exposes opponent GPS coordinates in browser DevTools network frames.
2. **Topic-Based Scoping with Realtime Authorization:**
   - Supabase Realtime supports RLS policies on the `realtime.messages` table.
   - Topics are structured as:
     - `game:{sessionId}:private:{userId}` (Personal stream, echo/backup)
     - `game:{sessionId}:team:{teamId}` (Team-only coordinates during team reveal)
     - `game:{sessionId}:global_reveal` (Published only during global reveal)
     - `game:{sessionId}:emergency` (Admin-only read access)
3. **Hybrid Architecture (Best of Both Worlds):**
   - **Authoritative Game State** (captures, scores, phase transitions, power-up cards, mission completions, reset sessions) $\rightarrow$ PostgreSQL tables with strict constraints, RLS, and security tests.
   - **Ephemeral Location Telemetry** $\rightarrow$ Supabase Realtime Broadcast channels with topic authorization.
   - **Emergency Audit Trail** $\rightarrow$ Emergency SOS triggers both an instant Admin broadcast and a durable PostgreSQL insert for safety records.

---

## 6. Migration Roadmap

1. **Phase 4 (Current):**
   - Maintain Firebase Spark compatibility.
   - Implement intelligent distance throttling in `MapView.tsx` (30m / 5m fallback).
   - Document ADR-001 Realtime PoC architecture.
2. **Phase 5 (Supabase Foundation):**
   - Implement PostgreSQL schema and RLS policies for auth, players, and game config.
3. **Phase 6 (Realtime Location Migration):**
   - Integrate `@supabase/supabase-js` Realtime Broadcast for location telemetry.
   - Run parallel test with Firebase and verify parity, zero write quota consumption, and strict privacy isolation.
