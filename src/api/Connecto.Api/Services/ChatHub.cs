using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;

namespace Connecto.Api.Services
{
    public class ChatHub : Hub
    {
        // userId -> set of connectionIds (multi-tab support)
        private static readonly ConcurrentDictionary<string, HashSet<string>> UserConnectionMap = new(StringComparer.Ordinal);

        // connectionId -> (userId, guestName)
        private static readonly ConcurrentDictionary<string, (string UserId, string GuestName)> ConnectionProfiles = new(StringComparer.Ordinal);

        // matching queues and markers (keyed by userId)
        private static readonly ConcurrentQueue<string> WaitingQueue = new();
        private static readonly ConcurrentDictionary<string, byte> WaitingIndex = new(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, byte> IdleIndex = new(StringComparer.Ordinal);

        // sessions keyed by sessionId -> (user1Id, user2Id)
        private static readonly ConcurrentDictionary<string, (string user1, string user2)> ActiveSessions = new(StringComparer.Ordinal);
        private static readonly ConcurrentDictionary<string, string> SessionKeys = new(StringComparer.Ordinal);

        public override async Task OnConnectedAsync()
        {
            HttpContext? http = Context.GetHttpContext();
            string? userId = http?.Request.Query["access_token"].ToString();

            if (string.IsNullOrWhiteSpace(userId))
            {
                await Clients.Caller.SendAsync("Error", "Missing userId");
                Context.Abort();
                return;
            }

            string connectionId = Context.ConnectionId;

            UserConnectionMap.AddOrUpdate(userId,
                _ =>
                {
                    HashSet<string> s = new (StringComparer.Ordinal) { connectionId };
                    return s;
                },
                (_, existing) =>
                {
                    lock (existing)
                    {
                        existing.Add(connectionId);
                    }
                    return existing;
                });

            // profile record for this connection (guest name we set later in RegisterUser)
            ConnectionProfiles[connectionId] = (userId, string.Empty);

            await Clients.Caller.SendAsync("ReceiveConnectionId", connectionId);
            await BroadcastActiveUserCount();
            await base.OnConnectedAsync();
        }

        public Task RegisterUser(string guestName)
        {
            string connectionId = Context.ConnectionId;

            if (ConnectionProfiles.TryGetValue(connectionId, out var existing))
            {
                ConnectionProfiles[connectionId] = (existing.UserId, guestName);
            }

            return Task.CompletedTask;
        }

        public async Task JoinChat()
        {
            string connectionId = Context.ConnectionId;

            if (!ConnectionProfiles.TryGetValue(connectionId, out var currentProfile))
            {
                await Clients.Caller.SendAsync("Waiting", "User not registered properly.");
                return;
            }

            string userId = currentProfile.UserId;

            try
            {
                if (TryDequeueWaiting(out var matchedUserId))
                {
                    // matched user still exists
                    if (!UserConnectionMap.TryGetValue(matchedUserId, out var matchedConnections) || matchedConnections.Count == 0)
                    {
                        EnqueueWaiting(userId);
                        await Clients.Caller.SendAsync("Waiting", "Waiting for a match...");
                        return;
                    }

                    // prevent same user pairing (same stable userId)
                    if (matchedUserId == userId)
                    {
                        EnqueueWaiting(userId);
                        await Clients.Caller.SendAsync("Waiting", "Waiting for a match...");
                        return;
                    }

                    // create session
                    string sessionId = $"{userId}-{matchedUserId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
                    ActiveSessions[sessionId] = (userId, matchedUserId);

                    string sessionKey = Convert.ToBase64String(Guid.NewGuid().ToByteArray());
                    SessionKeys[sessionId] = sessionKey;

                    // add all connectionIds for both users into the group
                    if (UserConnectionMap.TryGetValue(userId, out var userConns))
                    {
                        List<Task> tasks = [];
                        lock (userConns)
                        {
                            foreach (string cid in userConns) tasks.Add(Groups.AddToGroupAsync(cid, sessionId));
                        }
                        await Task.WhenAll(tasks);
                    }

                    if (UserConnectionMap.TryGetValue(matchedUserId, out var matchedConns))
                    {
                        List<Task> tasks2 = [];
                        lock (matchedConns)
                        {
                            foreach (string cid in matchedConns) tasks2.Add(Groups.AddToGroupAsync(cid, sessionId));
                        }
                        await Task.WhenAll(tasks2);
                    }

                    // remove from idle/wait lists
                    RemoveFromIdle(userId);
                    RemoveFromIdle(matchedUserId);

                    // prepare payloads with stable ids and names (resolve names from any connection)
                    string meName = TryGetAnyGuestNameForUser(userId) ?? "Unknown";
                    string partnerName = TryGetAnyGuestNameForUser(matchedUserId) ?? "Unknown";

                    // notify both users (send to each user's connections)
                    await SendToUser(userId, "SessionUpdate", new
                    {
                        sessionId,
                        me = new { id = userId, name = meName },
                        partner = new { id = matchedUserId, name = partnerName },
                        key = sessionKey
                    });

                    await SendToUser(matchedUserId, "SessionUpdate", new
                    {
                        sessionId,
                        me = new { id = matchedUserId, name = partnerName },
                        partner = new { id = userId, name = meName },
                        key = sessionKey
                    });
                }
                else
                {
                    EnqueueWaiting(userId);
                    await Clients.Caller.SendAsync("Waiting", "Waiting for a match...");
                }
            }
            catch (Exception ex)
            {
                // safe fallback: keep caller queued
                EnqueueWaiting(userId);
                await Clients.Caller.SendAsync("Waiting", "Error occurred. Try again.");
                Console.WriteLine($"JoinChat exception: {ex}");
            }
        }

        public async Task SkipChat(string sessionId)
        {
            string connectionId = Context.ConnectionId;
            if (!ConnectionProfiles.TryGetValue(connectionId, out var profile)) return;
            string userId = profile.UserId;
            string skipperName = TryGetAnyGuestNameForUser(userId) ?? "Partner";

            if (ActiveSessions.TryRemove(sessionId, out var users))
            {
                string otherUserId = users.user1 == userId ? users.user2 : users.user1;

                // notify partner
                await SendToUser(otherUserId, "PartnerSkipped", $"{skipperName} left the chat.");

                // notify skipper
                await SendToUser(userId, "YouSkipped", "You left the chat.");

                // remove both users' connections from the group
                List<Task> tasks = [];
                if (UserConnectionMap.TryGetValue(userId, out var uConns))
                {
                    lock (uConns) foreach (string cid in uConns) tasks.Add(Groups.RemoveFromGroupAsync(cid, sessionId));
                }
                if (UserConnectionMap.TryGetValue(otherUserId, out var oConns))
                {
                    lock (oConns) foreach (string cid in oConns) tasks.Add(Groups.RemoveFromGroupAsync(cid, sessionId));
                }
                await Task.WhenAll(tasks);

                SessionKeys.TryRemove(sessionId, out _);

                // both move to idle (they must press Next to queue)
                MoveToIdle(userId);
                MoveToIdle(otherUserId);
            }
        }

        public async Task NextChat()
        {
            string connectionId = Context.ConnectionId;
            if (!ConnectionProfiles.TryGetValue(connectionId, out var profile)) return;
            string userId = profile.UserId;

            // Ensure user not sitting in any active session (clean up stale session references)
            foreach (var kvp in ActiveSessions.ToArray())
            {
                if (kvp.Value.user1 == userId || kvp.Value.user2 == userId)
                {
                    ActiveSessions.TryRemove(kvp.Key, out _);
                    SessionKeys.TryRemove(kvp.Key, out _);

                    // remove user's connections from that group
                    List<Task> tasks = [];
                    if (UserConnectionMap.TryGetValue(userId, out var conns))
                    {
                        lock (conns) foreach (string cid in conns) tasks.Add(Groups.RemoveFromGroupAsync(cid, kvp.Key));
                    }
                    // also remove other user's connections from group
                    string otherUserId = kvp.Value.user1 == userId ? kvp.Value.user2 : kvp.Value.user1;
                    if (UserConnectionMap.TryGetValue(otherUserId, out var otherConns))
                    {
                        lock (otherConns) foreach (string cid in otherConns) tasks.Add(Groups.RemoveFromGroupAsync(cid, kvp.Key));
                    }
                    await Task.WhenAll(tasks);
                }
            }

            // Requeue for matching
            RemoveFromIdle(userId);
            WaitingIndexTryRemove(userId);
            EnqueueWaiting(userId);
            await JoinChat();
        }

        public async Task SendMessage(string sessionId, string message)
        {
            string connectionId = Context.ConnectionId;
            if (!ConnectionProfiles.TryGetValue(connectionId, out var profile))
            {
                await Clients.Caller.SendAsync("Error", "User not found.");
                return;
            }
            string userId = profile.UserId;

            if (!ActiveSessions.TryGetValue(sessionId, out var pair))
            {
                await Clients.Caller.SendAsync("Error", "Invalid session.");
                return;
            }

            // ensure caller belongs to this session
            if (pair.user1 != userId && pair.user2 != userId)
            {
                await Clients.Caller.SendAsync("Error", "Invalid session for user.");
                return;
            }

            string fromName = TryGetAnyGuestNameForUser(userId) ?? "Unknown";

            // broadcast to group's connections
            await Clients.Group(sessionId).SendAsync("ReceiveMessage", new
            {
                userId,
                from = fromName,
                text = message,
                timestamp = DateTimeOffset.UtcNow
            });
        }

        public async Task SendVoiceNote(string sessionId, string base64Audio)
        {
            string connectionId = Context.ConnectionId;
            if (!ConnectionProfiles.TryGetValue(connectionId, out var profile))
            {
                await Clients.Caller.SendAsync("Error", "User not found.");
                return;
            }
            string userId = profile.UserId;
            await Clients.Group(sessionId).SendAsync("ReceiveVoiceNote", new
            {
                userId,
                from = TryGetAnyGuestNameForUser(userId) ?? "Unknown",
                audio = base64Audio
            });
        }

        public async Task SendImage(string sessionId, string fromUser, string base64Image)
        {
            await Clients.Group(sessionId).SendAsync("UploadingImage", new
            {
                From = fromUser,
            });

            if (string.IsNullOrEmpty(base64Image)) return;
            string fromName = TryGetAnyGuestNameForUser(fromUser) ?? "Unknown";
          
            await Clients.Group(sessionId).SendAsync("ReceiveImage", new
            {
                userId = fromUser,
                from = fromName,
                Base64 = base64Image,
                Timestamp = DateTime.UtcNow
            });
        }

        public override async Task OnDisconnectedAsync(Exception? exception)
        {
            string connectionId = Context.ConnectionId;

            if (!ConnectionProfiles.TryRemove(connectionId, out var profile))
            {
                await BroadcastActiveUserCount();
                await base.OnDisconnectedAsync(exception);
                return;
            }

            string userId = profile.UserId;
            string departingName = profile.GuestName;
            bool isPhysicallyConnected = true;

            // remove this connection from user's connections
            if (UserConnectionMap.TryGetValue(userId, out var conns))
            {
                lock (conns)
                {
                    conns.Remove(connectionId);
                    if (conns.Count == 0)
                    {
                        isPhysicallyConnected = false;
                    }
                }
            }
            
            if (!isPhysicallyConnected)
            {
                await Task.Delay(20000);

                if (UserConnectionMap.TryGetValue(userId, out var checkConns))
                {
                    lock (checkConns)
                    {
                        if (checkConns.Count > 0) isPhysicallyConnected = true;
                    }
                }

                if (!isPhysicallyConnected)
                {
                    // no more live connections for this userId -> treat as full disconnect
                    UserConnectionMap.TryRemove(userId, out _);

                    // Remove from waiting/idle
                    WaitingIndexTryRemove(userId);
                    IdleIndexTryRemove(userId);
                    RebuildWaitingQueueExcluding(userId);

                    // if user was in a session, notify partner and move them idle
                    var session = ActiveSessions.FirstOrDefault(s => s.Value.user1 == userId || s.Value.user2 == userId);
                    if (!session.Equals(default(KeyValuePair<string, (string user1, string user2)>)))
                    {
                        ActiveSessions.TryRemove(session.Key, out var users);
                        string otherUserId = users.user1 == userId ? users.user2 : users.user1;

                        // notify partner that this user disconnected
                        _ = SendToUser(otherUserId, "PartnerDisconnected", $"{departingName ?? "Partner"} left the chat.");

                        MoveToIdle(otherUserId);
                        SessionKeys.TryRemove(session.Key, out _);
                    }
                }
            }

            await BroadcastActiveUserCount();
            await base.OnDisconnectedAsync(exception);
        }

        public Task RemoveUser(string userId)
        {
            // if user has connections, remove them
            if (UserConnectionMap.TryRemove(userId, out var conns))
            {
                // remove all connection profiles
                foreach (string cid in conns.ToArray())
                {
                    ConnectionProfiles.TryRemove(cid, out _);
                }

                // remove from waiting/idle
                WaitingIndexTryRemove(userId);
                IdleIndexTryRemove(userId);
                RebuildWaitingQueueExcluding(userId);

                // clean active sessions where this user participated
                foreach (var kvp in ActiveSessions.ToArray())
                {
                    if (kvp.Value.user1 == userId || kvp.Value.user2 == userId)
                    {
                        ActiveSessions.TryRemove(kvp.Key, out var users);
                        string otherUserId = users.user1 == userId ? users.user2 : users.user1;

                        // notify partner and move them idle
                        _ = SendToUser(otherUserId, "PartnerDisconnected", $"{TryGetAnyGuestNameForUser(userId) ?? "Partner"} left the chat.");
                        MoveToIdle(otherUserId);

                        SessionKeys.TryRemove(kvp.Key, out _);
                    }
                }
            }
            return Task.CompletedTask;
        }

        public async Task SendTyping(string fromUser, string toUser)
        {
            await SendToUser(toUser, "UserTyping", new
            {
                From = TryGetAnyGuestNameForUser(fromUser) ?? "User"
            });
        }

        public async Task SendTypingStopped(string fromUser, string toUser)
        {
            await SendToUser(toUser, "UserTypingStopped", new { From = fromUser });
        }

        private Task BroadcastActiveUserCount()
        {
            int userCount = ConnectionProfiles.Count;
            return Clients.All.SendAsync("ActiveUserCountUpdated", userCount);
        }

        // --- CALL / SIGNALING implementations ---

        public async Task StartCall(string sessionId, string fromUser, string toUser)
        {
            string callGroup = $"call_{sessionId}";

            if (UserConnectionMap.TryGetValue(fromUser, out var callerConns))
            {
                List<Task> tasks = [];
                lock (callerConns)
                {
                    foreach (string cid in callerConns) tasks.Add(Groups.AddToGroupAsync(cid, callGroup));
                }
                await Task.WhenAll(tasks);
            }
            else
            {
                await Groups.AddToGroupAsync(Context.ConnectionId, callGroup);
            }

            if (UserConnectionMap.TryGetValue(toUser, out var calleeConns))
            {
                List<Task> tasks = [];
                lock (calleeConns)
                {
                    foreach (string cid in calleeConns) tasks.Add(Groups.AddToGroupAsync(cid, callGroup));
                }
                await Task.WhenAll(tasks);
            }

            await SendToUser(fromUser, "OutgoingCallStarted", new
            {
                To = TryGetAnyGuestNameForUser(toUser) ?? "Unknown",
                SessionId = sessionId
            });

            await SendToUser(toUser, "IncomingCall", new
            {
                From = TryGetAnyGuestNameForUser(fromUser) ?? "Unknown",
                SessionId = sessionId
            });
        }

        public async Task AcceptCall(string sessionId, string fromUser, string toUser)
        {
            await SendToUser(fromUser, "CallAccepted", new
            {
                From = toUser,
                SessionId = sessionId
            });

            await SendToUser(toUser, "CallAccepted", new
            {
                From = fromUser,
                SessionId = sessionId
            });
        }

        public async Task RejectCall(string sessionId, string fromUser, string toUser)
        {
            await SendToUser(fromUser, "CallRejected", new
            {
                From = toUser,
                SessionId = sessionId
            });

            await SendToUser(toUser, "CallRejected", new
            {
                From = toUser,
                SessionId = sessionId
            });
        }

        public async Task EndCall(string sessionId, string fromUser, string toUser)
        {
            string callGroup = $"call_{sessionId}";

            await SendToUser(fromUser, "CallEnded", new { From = toUser, SessionId = sessionId });
            await SendToUser(toUser, "CallEnded", new { From = fromUser, SessionId = sessionId });

            if (UserConnectionMap.TryGetValue(fromUser, out var fromConns))
            {
                List<Task> tasks = [];
                lock (fromConns)
                {
                    foreach (string cid in fromConns) tasks.Add(Groups.RemoveFromGroupAsync(cid, callGroup));
                }
                await Task.WhenAll(tasks);
            }

            if (UserConnectionMap.TryGetValue(toUser, out var toConns))
            {
                List<Task> tasks = [];
                lock (toConns)
                {
                    foreach (string cid in toConns) tasks.Add(Groups.RemoveFromGroupAsync(cid, callGroup));
                }
                await Task.WhenAll(tasks);
            }
        }

        public async Task Ping() => await Clients.Caller.SendAsync("Pong");

        public async Task SendSignal(string sessionId, string fromUser, string signalType, string data)
        {
            // IMPORTANT: do not attempt to parse or inspect data.
            await Clients.Group(sessionId).SendAsync("ReceiveSignal", new
            {
                From = fromUser,
                Type = signalType,
                Data = data
            });
        }

        public async Task JoinSession(string sessionId, string userId)
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, sessionId);
            if (!ConnectionProfiles.ContainsKey(Context.ConnectionId))
                ConnectionProfiles[Context.ConnectionId] = (userId, string.Empty);
        }

        // -------------------- Helpers: queue / name / send --------------------

        private static void EnqueueWaiting(string userId)
        {
            // remove from idle if present
            IdleIndex.TryRemove(userId, out _);
            if (WaitingIndex.TryAdd(userId, 0))
                WaitingQueue.Enqueue(userId);
        }

        private static bool TryDequeueWaiting(out string userId)
        {
            while (WaitingQueue.TryDequeue(out userId))
            {
                if (WaitingIndex.TryRemove(userId, out _)) return true;
            }
            userId = null!;
            return false;
        }

        private static void MoveToIdle(string userId)
        {
            WaitingIndex.TryRemove(userId, out _);
            IdleIndex[userId] = 0;
        }

        private static void RemoveFromIdle(string userId)
        {
            if (string.IsNullOrEmpty(userId)) return;

            IdleIndex.TryRemove(userId, out _);
            WaitingIndex.TryRemove(userId, out _);
            RebuildWaitingQueueExcluding(userId);
        }

        private static void WaitingIndexTryRemove(string userId)
        {
            WaitingIndex.TryRemove(userId, out _);
        }

        private static void IdleIndexTryRemove(string userId)
        {
            IdleIndex.TryRemove(userId, out _);
        }

        private static void RebuildWaitingQueueExcluding(string excludeUserId)
        {
            // Rebuild queue excluding a specific user
            List<string> remaining = [.. WaitingQueue.Where(u => u != excludeUserId)];
            while (WaitingQueue.TryDequeue(out _)) { }
            foreach (string u in remaining) WaitingQueue.Enqueue(u);
        }

        private static string? TryGetAnyGuestNameForUser(string userId)
        {
            if (UserConnectionMap.TryGetValue(userId, out var conns))
            {
                lock (conns)
                {
                    foreach (string cid in conns)
                    {
                        if (ConnectionProfiles.TryGetValue(cid, out var p) && !string.IsNullOrEmpty(p.GuestName))
                            return p.GuestName;
                    }
                }
            }
            return null;
        }

        private Task SendToUser(string userId, string method, object payload)
        {
            if (!UserConnectionMap.TryGetValue(userId, out var conns) || conns.Count == 0)
                return Task.CompletedTask;

            List<Task> tasks = [];
            lock (conns)
            {
                foreach (string cid in conns)
                {
                    tasks.Add(Clients.Client(cid).SendAsync(method, payload));
                }
            }
            return Task.WhenAll(tasks);
        }
    }
}
