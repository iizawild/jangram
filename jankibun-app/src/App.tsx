import { useState, useRef, useEffect } from "react"

/* ========= 型定義 ========= */

type Player = "A" | "B" | "C" | "D"


type Settlement = {
  rateYenPerPt: number        // 1ptあたりの円
  tableFee: number            // 場代（合計）
  foodFee: Record<Player, number> // 食事代（個別）
}

type Session = {
  id: string
  title: string
  date: string
  location?: string
  rounds: { scores: Record<Player, ScoreState> }[]
  settlement: Settlement
}

type ScoreState = {
  value: number | ""
  updatedAt: number | null
}

type RoundResult = {
  player: Player
  rawScore: number
  roundedScore: number
  rank: number
  point: number
}

const STORAGE_KEY = "jangram_sessions"

/* ========= ルール設定 ========= */

const PLAYER_COUNT = 4
const STARTING_POINTS = 25000
const RETURN_POINTS = 30000
const UMA = [20, 10, -10, -20]

/* 五捨六入（1000点単位） */
function roundScore(score: number): number {
  // プラス点数：五捨六入
  if (score >= 0) {
    const base = Math.floor(score / 1000) * 1000
    return score % 1000 >= 600 ? base + 1000 : base
  }

  // マイナス点数：絶対値で「四捨五入」してから符号復元
  const abs = Math.abs(score)
  const base = Math.floor(abs / 1000) * 1000
  const rounded = abs % 1000 >= 500 ? base + 1000 : base
  return -rounded
}

/* ========= 正規化（自動計算） ========= */

function normalizeScores(
  scores: Record<Player, ScoreState>
): Record<Player, ScoreState> {

  const entries = Object.entries(scores).map(([player, s]) => ({
    player: player as Player,
    ...s,
  }))

  const filled = entries.filter(e => e.value !== "")
  const empty = entries.filter(e => e.value === "")

  // ★ 3人確定・1人未入力の「確定後」だけ自動計算
  if (filled.length === 3 && empty.length === 1) {
    const total = STARTING_POINTS * PLAYER_COUNT
    const sumFilled = filled.reduce(
      (sum, e) => sum + Number(e.value),
      0
    )

    const autoScore = total - sumFilled
    const target = empty[0].player

    return {
      ...scores,
      [target]: {
        value: autoScore,
        updatedAt: Date.now(), // 最後に確定した扱い
      },
    }
  }

  return scores
}

/* ========= 麻雀計算本体 ========= */

function recalcRound(
  scores: Record<Player, ScoreState>
): RoundResult[] {

  // 素点確定済みのみ対象
  const entries = Object.entries(scores)
    .filter(([, s]) => s.value !== "")
    .map(([player, s]) => ({
      player: player as Player,
      rawScore: s.value as number,
      updatedAt: s.updatedAt as number,
    }))

  if (entries.length !== PLAYER_COUNT) {
    return []
  }

  // 順位決定（素点 → 同点は入力順）
  entries.sort((a, b) => {
    if (b.rawScore !== a.rawScore) {
      return b.rawScore - a.rawScore
    }
    return a.updatedAt - b.updatedAt
  })

  // 丸め
  const rounded = entries.map(e => ({
    ...e,
    roundedScore: roundScore(e.rawScore),
  }))

  // 丸め誤差調整（トップ）
  const roundedTotal = rounded.reduce(
    (sum, e) => sum + e.roundedScore,
    0
  )
  const expectedTotal = STARTING_POINTS * PLAYER_COUNT
  const diff = roundedTotal - expectedTotal
  if (diff !== 0) {
    rounded[0].roundedScore -= diff
  }

  // オカ・ウマ込みポイント
  const okaTotal =
    (RETURN_POINTS - STARTING_POINTS) * PLAYER_COUNT

  return rounded.map((e, index) => {
    const rank = index + 1
    const basePoint =
      (e.roundedScore - RETURN_POINTS) / 1000
    const oka = rank === 1 ? okaTotal / 1000 : 0
    const uma = UMA[index] ?? 0

    return {
      player: e.player,
      rawScore: e.rawScore,
      roundedScore: e.roundedScore,
      rank,
      point: basePoint + oka + uma,
    }
  })
}

function calcSettlement4p(
  rounds: { scores: Record<Player, ScoreState> }[],
  players: Player[],
  settlement: Settlement
) {
  const totalPt: Record<Player, number> = {
    A: 0,
    B: 0,
    C: 0,
    D: 0,
  }

  rounds.forEach(round => {
    recalcRound(round.scores).forEach(r => {
      totalPt[r.player] += r.point
    })
  })

  const rate = settlement.rateYenPerPt
  const tableShare = settlement.tableFee / 4

  return players.map(player => {
    const yen = totalPt[player] * rate
    const food = settlement.foodFee[player] ?? 0
    const final = yen - tableShare - food

    return {
      player,
      pt: totalPt[player],
      final,
    }
  })
}

/* ========= UI ========= */

function App() {
  const players: Player[] = ["A", "B", "C", "D"]

  const emptyScores: Record<Player, ScoreState> = {
    A: { value: "", updatedAt: null },
    B: { value: "", updatedAt: null },
    C: { value: "", updatedAt: null },
    D: { value: "", updatedAt: null },
  }

  type Mode = "idle" | "edit" | "delete"

  const [sessions, setSessions] = useState<Session[]>([])

  const [currentSession, setCurrentSession] =
    useState<Session | null>(null)

  const [mode, setMode] = useState<Mode>("idle")

  const [activeRoundIndex, setActiveRoundIndex] =
    useState<number | null>(null)

  const [hasLoaded, setHasLoaded] = useState(false)

  // Sessionタイトル編集用
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")

  // 入力欄に表示するスコア（新規 / 修正 / 削除確認 共通）
  const [inputScores, setInputScores] =
    useState<Record<Player, ScoreState>>(emptyScores)

  const firstInputRef = useRef<HTMLInputElement | null>(null)

  // ✅ 起動時復元
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      try {
        const parsed: Session[] = JSON.parse(stored)
        setSessions(parsed)
      } catch (e) {
        console.error("localStorage の読み込みに失敗", e)
      }
    }
    setHasLoaded(true) // ✅ 復元完了フラグ
  }, [])

  // ✅ 自動保存
  useEffect(() => {
    if (!hasLoaded) return // ✅ 初回は保存しない
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions))
  }, [sessions, hasLoaded])

  const rounds = currentSession?.rounds ?? []

  return (
    <div style={{ padding: "16px" }}>
      <h1>JANGRAM</h1>


      <button
        onClick={() => {
          const newSession: Session = {
            id: crypto.randomUUID(),
            title: "新しい対局",
            date: new Date().toISOString(),
            location: "",
            rounds: [],
            settlement: {
              rateYenPerPt: 100, // デフォルト100円/pt
              tableFee: 0,
              foodFee: {
                A: 0,
                B: 0,
                C: 0,
                D: 0,
              },
            },
          }

          setSessions(prev => [...prev, newSession])
          setCurrentSession(newSession)

          // 操作状態もリセット
          setMode("idle")
          setActiveRoundIndex(null)
          setInputScores(emptyScores)
        }}
      >
        新しい対局を作成
      </button>

      <hr
        style={{
          margin: "24px 0",
          border: "none",
          borderTop: "1px solid #ddd",
        }}
      />
      <h2>対局一覧</h2>

      {sessions.length === 0 && (
        <p>まだ対局がありません</p>
      )}

      <ul>
        {sessions.map(session => (
          <li key={session.id} style={{ marginBottom: "4px" }}>
            <button
              onClick={() => setCurrentSession(session)}
              style={{ marginRight: "8px" }}
            >
              開く
            </button>


            {session.title}
            （{new Date(session.date).toLocaleDateString()}
            {session.location ? ` / ${session.location}` : ""}）

            <button
              onClick={() => {
                // ✅ sessions から削除
                setSessions(prev =>
                  prev.filter(s => s.id !== session.id)
                )

                // ✅ 削除したものを開いていた場合は閉じる
                setCurrentSession(prev =>
                  prev?.id === session.id ? null : prev
                )

                // 操作状態もリセット
                setMode("idle")
                setActiveRoundIndex(null)
                setInputScores(emptyScores)
              }}
              style={{ marginLeft: "8px", color: "#c00" }}
            >
              削除
            </button>
          </li>
        ))}
      </ul>

      <hr
        style={{
          margin: "24px 0",
          border: "none",
          borderTop: "1px solid #ddd",
        }}
      />
      {/* ✅ Step4：Session があるときだけ表示 */}
      {currentSession && (
        <>
          {/* ① Sessionタイトル */}
          {/* ✅ Sessionタイトル編集 */}
          <h2>
            {!editingTitle ? (
              <span
                onClick={() => {
                  setEditingTitle(true)
                  setTitleDraft(currentSession.title)
                }}
                style={{ cursor: "pointer" }}
              >
                {currentSession.title}
              </span>
            ) : (
              <input
                value={titleDraft}
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={() => {
                  if (!currentSession) return

                  const updated = {
                    ...currentSession,
                    title: titleDraft.trim() || "無題の対局",
                  }

                  setCurrentSession(updated)
                  setSessions(prev =>
                    prev.map(s =>
                      s.id === updated.id ? updated : s
                    )
                  )

                  setEditingTitle(false)
                }}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur()
                  }
                }}
                autoFocus
              />
            )}
          </h2>

          {/* ② 対局日・場所 */}
          {/* ✅ Step3：日時・場所入力（←ここ！） */}
          <div style={{ marginBottom: "8px" }}>
            <div>
              <label>
                対局日：
                <input
                  type="date"
                  value={currentSession.date.slice(0, 10)}
                  onChange={e => {
                    const updated = {
                      ...currentSession,
                      date: new Date(e.target.value).toISOString(),
                    }

                    setCurrentSession(updated)
                    setSessions(prev =>
                      prev.map(s => (s.id === updated.id ? updated : s))
                    )
                  }}
                  style={{ marginLeft: "4px" }}
                />
              </label>
            </div>

            <div style={{ marginTop: "4px" }}>
              <label>
                場所：
                <input
                  type="text"
                  value={currentSession.location ?? ""}
                  onChange={e => {
                    const updated = {
                      ...currentSession,
                      location: e.target.value,
                    }

                    setCurrentSession(updated)
                    setSessions(prev =>
                      prev.map(s => (s.id === updated.id ? updated : s))
                    )
                  }}
                  placeholder="例：自宅、フリー、〇〇店"
                  style={{ marginLeft: "4px" }}
                />
              </label>
            </div>
          </div>

          {/* ③ 成績表 */}
          {/* ↓↓↓ ここから今までの半荘UI ↓↓↓ */}
          <h2 style={{ marginTop: "24px" }}>成績表</h2>
          <table
            style={{
              borderCollapse: "collapse",
              width: "100%",
              marginTop: "8px",
            }}
          >
            <thead>
              <tr>
                <th style={{ border: "1px solid #ccc", padding: "4px" }}>
                  半荘
                </th>

                {players.map(player => (
                  <th
                    key={player}
                    style={{ border: "1px solid #ccc", padding: "4px" }}
                  >
                    {player}
                  </th>
                ))}

                <th style={{ border: "1px solid #ccc", padding: "4px" }}>
                  操作
                </th>
              </tr>
            </thead>

            <tbody>
              {rounds.map((round, index) => {
                const results = recalcRound(round.scores)

                return (
                  <tr
                    key={index}
                    style={{
                      backgroundColor:
                        mode !== "idle" && activeRoundIndex === index
                          ? mode === "edit"
                            ? "#fffbe6"   // 修正中（淡い黄色）
                            : "#ffeaea"   // 削除中（淡い赤）
                          : undefined,
                    }}
                  >
                    <td style={{ border: "1px solid #ccc", padding: "4px" }}>
                      半荘 {index + 1}
                    </td>

                    {players.map(player => {
                      const r = results.find(r => r.player === player)
                      const point = r ? r.point : 0

                      return (
                        <td
                          key={player}
                          style={{
                            border: "1px solid #ccc",
                            padding: "4px",
                            color: point < 0 ? "red" : "green",
                          }}
                        >
                          {r ? point.toFixed(1) : ""}
                        </td>
                      )
                    })}

                    <td
                      style={{
                        border: "1px solid #ccc",
                        padding: "4px",
                        textAlign: "center",
                      }}
                    >
                      {/* idle のときだけ 修正・削除 */}
                      {mode === "idle" && (
                        <>
                          <button
                            onClick={() => {
                              setMode("edit")
                              setActiveRoundIndex(index)
                              setInputScores(round.scores)
                            }}
                            style={{ marginRight: "4px" }}
                          >
                            修正
                          </button>

                          <button
                            onClick={() => {
                              setMode("delete")
                              setActiveRoundIndex(index)
                              setInputScores(round.scores)
                            }}
                          >
                            削除
                          </button>
                        </>
                      )}

                      {/* 修正中 */}
                      {mode === "edit" && activeRoundIndex === index && (
                        <span style={{ color: "#b58900" }}>修正中</span>
                      )}

                      {/* 削除中 */}
                      {mode === "delete" && activeRoundIndex === index && (
                        <span style={{ color: "#c00" }}>削除中</span>
                      )}
                    </td>
                  </tr>
                )
              })}

              {/* ===== 合計行 ===== */}
              <tr style={{ backgroundColor: "#f2f2f2" }}>
                <td
                  style={{
                    border: "1px solid #ccc",
                    borderTop: "2px solid #666",
                    padding: "4px",
                    fontWeight: "bold",
                  }}
                >
                  合計
                </td>

                {players.map(player => {
                  const totalPoint = rounds.reduce((sum, round) => {
                    const results = recalcRound(round.scores)
                    const r = results.find(r => r.player === player)
                    return sum + (r ? r.point : 0)
                  }, 0)

                  return (
                    <td
                      key={player}
                      style={{
                        border: "1px solid #ccc",
                        borderTop: "2px solid #666",
                        padding: "4px",
                        fontWeight: "bold",
                        color: totalPoint < 0 ? "red" : "green",
                      }}
                    >
                      {totalPoint.toFixed(1)}
                    </td>
                  )
                })}

                <td
                  style={{
                    border: "1px solid #ccc",
                    borderTop: "2px solid #666",
                  }}
                />
              </tr>
            </tbody>
          </table>

          {/* ④ 入力中の半荘 */}
          <h3 style={{ color: "#333" }}>入力中の半荘</h3>
          <table
            style={{
              borderCollapse: "collapse",
              width: "100%",
              marginTop: "8px",
              backgroundColor: "#f9f9f9",
            }}
          >
            <tbody>
              <tr>
                {/* 行ラベル */}
                <td
                  style={{
                    border: "1px solid #ccc",
                    padding: "4px",
                    fontWeight: "bold",
                  }}
                >
                  入力
                </td>

                {/* 各プレイヤー入力欄 */}
                {players.map(player => (
                  <td
                    key={player}
                    style={{
                      border: "1px solid #ccc",
                      padding: "4px",
                    }}
                  >
                    <input
                      ref={player === players[0] ? firstInputRef : null}
                      type="number"
                      value={inputScores[player].value}
                      onChange={e => {
                        const raw = e.target.value
                        setInputScores(prev => ({
                          ...prev,
                          [player]: {
                            value: raw === "" ? "" : Number(raw),
                            updatedAt: raw === "" ? null : Date.now(),
                          },
                        }))
                      }}
                      onBlur={() => {
                        setInputScores(prev => normalizeScores(prev))
                      }}
                      style={{ width: "80px" }}
                    />
                  </td>
                ))}

                <td
                  style={{
                    border: "1px solid #ccc",
                    padding: "4px",
                    textAlign: "center",
                  }}
                >
                  <>
                    {/* === キャンセル（edit / delete のときだけ表示） === */}
                    {(mode === "edit" || mode === "delete") && (
                      <button
                        onClick={() => {
                          setMode("idle")
                          setActiveRoundIndex(null)
                          setInputScores(emptyScores)
                        }}
                        style={{ marginRight: "6px" }}
                      >
                        キャンセル
                      </button>
                    )}

                    {/* === 確定 === */}
                    <button
                      onClick={() => {
                        // ===== 新規追加 =====
                        if (mode === "idle") {
                          const normalized = normalizeScores(inputScores)

                          setCurrentSession(prev => {
                            if (!prev) return prev

                            const updated = {
                              ...prev,
                              rounds: [...prev.rounds, { scores: normalized }],
                            }

                            // ✅ sessions 側も必ず更新
                            setSessions(sessions =>
                              sessions.map(s => (s.id === updated.id ? updated : s))
                            )

                            return updated
                          })

                          setInputScores(emptyScores)
                          return
                        }

                        // ===== 修正確定 =====
                        if (mode === "edit" && activeRoundIndex !== null) {
                          const normalized = normalizeScores(inputScores)

                          setCurrentSession(prev => {
                            if (!prev || activeRoundIndex === null) return prev

                            const updated = {
                              ...prev,
                              rounds: prev.rounds.map((r, i) =>
                                i === activeRoundIndex ? { scores: normalized } : r
                              ),
                            }

                            setSessions(sessions =>
                              sessions.map(s => (s.id === updated.id ? updated : s))
                            )

                            return updated
                          })

                          setMode("idle")
                          setActiveRoundIndex(null)
                          setInputScores(emptyScores)
                          return
                        }

                        // ===== 削除確定 =====
                        if (mode === "delete" && activeRoundIndex !== null) {
                          setCurrentSession(prev => {
                            if (!prev || activeRoundIndex === null) return prev

                            const updated = {
                              ...prev,
                              rounds: prev.rounds.filter((_, i) => i !== activeRoundIndex),
                            }

                            setSessions(sessions =>
                              sessions.map(s => (s.id === updated.id ? updated : s))
                            )

                            return updated
                          })

                          setMode("idle")
                          setActiveRoundIndex(null)
                          setInputScores(emptyScores)
                        }
                      }}
                    >
                      {mode === "idle" && "確定"}
                      {mode === "edit" && "修正確定"}
                      {mode === "delete" && "削除確定"}
                    </button>
                  </>
                </td>
              </tr>
            </tbody>
          </table>

          <hr
            style={{
              margin: "32px 0",
              border: "none",
              borderTop: "2px solid #999",
            }}
          />

          {/* ⑤ 精算条件（← 下の方へ移動） */}
          <h3 style={{ color: "#333" }}>精算条件</h3>
          <div style={{ marginBottom: "12px" }}>
            {/* レート */}
            <div>
              <label>
                レート（1ptあたり）：
                <input
                  type="number"
                  value={currentSession.settlement.rateYenPerPt}
                  onChange={e => {
                    const updated = {
                      ...currentSession,
                      settlement: {
                        ...currentSession.settlement,
                        rateYenPerPt: Number(e.target.value),
                      },
                    }
                    setCurrentSession(updated)
                    setSessions(prev =>
                      prev.map(s => (s.id === updated.id ? updated : s))
                    )
                  }}
                  style={{ marginLeft: "4px", width: "80px" }}
                />
                円
              </label>
            </div>

            {/* 場代 */}
            <div style={{ marginTop: "4px" }}>
              <label>
                場代：
                <input
                  type="number"
                  value={currentSession.settlement.tableFee}
                  onChange={e => {
                    const updated = {
                      ...currentSession,
                      settlement: {
                        ...currentSession.settlement,
                        tableFee: Number(e.target.value),
                      },
                    }
                    setCurrentSession(updated)
                    setSessions(prev =>
                      prev.map(s => (s.id === updated.id ? updated : s))
                    )
                  }}
                  style={{ marginLeft: "4px", width: "80px" }}
                />
                円
              </label>
            </div>

            {/* 食事代 */}
            <div style={{ marginTop: "8px" }}>
              <strong>食事代</strong>
              <div>
                {players.map(player => (
                  <label key={player} style={{ marginRight: "12px" }}>
                    {player}：
                    <input
                      type="number"
                      value={currentSession.settlement.foodFee[player]}
                      onChange={e => {
                        const updated = {
                          ...currentSession,
                          settlement: {
                            ...currentSession.settlement,
                            foodFee: {
                              ...currentSession.settlement.foodFee,
                              [player]: Number(e.target.value),
                            },
                          },
                        }
                        setCurrentSession(updated)
                        setSessions(prev =>
                          prev.map(s => (s.id === updated.id ? updated : s))
                        )
                      }}
                      style={{ marginLeft: "4px", width: "60px" }}
                    />
                    円
                  </label>
                ))}
              </div>
            </div>
          </div>

          <hr
            style={{
              margin: "24px 0",
              border: "none",
              borderTop: "1px solid #ddd",
            }}
          />
          {/* ⑥ 精算結果（一番最後） */}
          <h3 style={{ textAlign: "center", color: "#333" }}>精算結果</h3>
          <table
            style={{
              borderCollapse: "collapse",
              marginTop: "8px",
              marginLeft: "auto",
              marginRight: "auto",
              border: "2px solid #666",       // ★ 外枠をしっかり
              backgroundColor: "#f7f7f7",
            }}
          >
            <thead>
              <tr>
                <th style={{ border: "1px solid #999", padding: "4px 8px" }}>
                  プレイヤー
                </th>
                <th style={{ border: "1px solid #999", padding: "4px 8px" }}>
                  合計pt
                </th>
                <th style={{ border: "1px solid #999", padding: "4px 8px" }}>
                  精算
                </th>
              </tr>
            </thead>
            <tbody>
              {calcSettlement4p(
                currentSession.rounds,
                players,
                currentSession.settlement
              ).map(r => {
                const abs = Math.abs(r.final)

                let label = "±0円"
                let color = "#555"

                if (r.final > 0) {
                  label = `＋${abs.toLocaleString()}円（受取）`
                  color = "green"
                } else if (r.final < 0) {
                  label = `－${abs.toLocaleString()}円（支払）`
                  color = "red"
                }

                return (
                  <tr
                    key={r.player}
                    style={{
                      borderBottom: "1px solid #ccc", // ✅ 横罫線は行で統一
                    }}
                  >
                    <td
                      style={{
                        borderLeft: "1px solid #ccc",
                        borderRight: "1px solid #ccc",
                        padding: "6px 10px",
                        textAlign: "center",
                      }}
                    >
                      {r.player}
                    </td>

                    <td
                      style={{
                        borderRight: "1px solid #ccc",
                        padding: "6px 10px",
                        textAlign: "right",
                      }}
                    >
                      {r.pt.toFixed(1)}
                    </td>

                    <td
                      style={{
                        borderRight: "1px solid #ccc",
                        padding: "6px 10px",
                        color,
                        fontWeight: "bold",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </td>
                  </tr>
                )
              })}
            </tbody>

          </table>


          {/* ↑↑↑ 今までのUIここまで ↑↑↑ */}
        </>
      )}

    </div>
  )
}

export default App
