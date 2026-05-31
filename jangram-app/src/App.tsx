import { useState, useRef, useEffect, useMemo } from "react"

/* ========= 型定義 ========= */

type Player = "A" | "B" | "C" | "D"
const PLAYERS: Player[] = ["A", "B", "C", "D"]

type Mode = "idle" | "edit"

type Settlement = {
  rateYenPerPt: number        // 1ptあたりの円
  tableFee: number            // 場代（合計）
  foodFee: Record<Player, number> // 食事代（個別）
}

type Round = {
  scores: Record<Player, ScoreState>

  events?: {
    tobashi?: {
      by: Player
      targets: Player[]
    }[]

    yakuman?: {
      winner: Player
      key: string
      type: "tsumo" | "ron"
      role: "parent" | "child"
      count: number
      dealer?: Player   // ← ★追加（役満時の親）
      discarder?: Player
      responsibility?: Player
      memo?: string
      directPoints?: Record<Player, number>
    }[]

  }
}

type Session = {
  id: string
  title: string
  date: string
  location?: string
  rounds: Round[]
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

/* ========= 定数 ========= */

// 永続化
const STORAGE_KEY = "jangram_sessions"

// 設定系
const PLAYER_COUNT = 4
const STARTING_POINTS = 25000
const RETURN_POINTS = 30000
const UMA = [20, 10, -10, -20]

const TOBASHI_POINT = 10

const YAKUMAN_TSUMO_CHILD_ALL = 20   // 全員均等
const YAKUMAN_TSUMO_CHILD_PARENT = 30 // 親負担
const YAKUMAN_TSUMO_CHILD_CHILD = 15 // 子負担
const USE_PARENT_EXTRA = true       // false = 全員均等, true = 親負担増

type YakumanType = {
  key: string
  label: string
  count: number
  responsibility: number
  directAdjust: number
}

// マスターデータ
const YAKUMAN_TYPES: YakumanType[] = [
  { key: "yakuman", label: "役満", count: 1, responsibility: 0, directAdjust: 0 },
  { key: "daisangen", label: "大三元", count: 1, responsibility: 1, directAdjust: 0 },
  { key: "daishushi", label: "大四喜", count: 1, responsibility: 1, directAdjust: 0 },
  { key: "sukantsu", label: "四槓子", count: 1, responsibility: 1, directAdjust: 0 },
  { key: "double", label: "ダブル役満", count: 2, responsibility: 0, directAdjust: 0 },
  { key: "daisangen_tsuui", label: "大三元字一色", count: 2, responsibility: 1, directAdjust: 1 },
  { key: "triple", label: "トリプル役満", count: 3, responsibility: 1, directAdjust: 0 },
]

/* ========= ルール設定 ========= */

/* 飛ばし祝儀計算 */
function calcBonusPoints(rounds: Round[]): Record<Player, number> {
  const result = Object.fromEntries(
    PLAYERS.map(p => [p, 0])
  ) as Record<Player, number>

  rounds.forEach(round => {

    // ===== 飛ばし祝儀 =====
    if (round.events?.tobashi) {
      round.events.tobashi.forEach(t => {
        t.targets.forEach(target => {
          result[t.by] += TOBASHI_POINT
          result[target] -= TOBASHI_POINT
        })
      })
    }

    // ===== 役満祝儀 =====
    if (round.events?.yakuman) {
      round.events.yakuman.forEach(y => {
        const total = 60 * y.count

        // ===== directAdjust（＝祝儀ポイント直接入力） =====
        if (y.directPoints !== undefined) {
          PLAYERS.forEach(p => {
            result[p] += Number(y.directPoints?.[p] ?? 0)
          })
          return
        }

        // ===== 責任払い =====
        if (y.responsibility !== undefined) {
          result[y.winner] += total
          result[y.responsibility] -= total
          return
        }

        if (y.type === "ron") {
          // ===== ロン =====
          if (y.discarder) {
            result[y.winner] += total
            result[y.discarder] -= total
          }

        } else if (y.type === "tsumo") {

          if (y.role === "parent") {
            // ===== 親ツモ =====
            const others = PLAYERS
              .filter(p => p !== y.winner)

            const share = total / 3

            result[y.winner] += total

            others.forEach(p => {
              result[p] -= share
            })

          } else {
            // ===== 子ツモ =====

            const others = PLAYERS
              .filter(p => p !== y.winner)

            // 和了者のプラス
            result[y.winner] += total

            if (!USE_PARENT_EXTRA) {
              // ===== 全員均等 =====
              others.forEach(p => {
                result[p] -= YAKUMAN_TSUMO_CHILD_ALL * y.count
              })

            } else {
              // ===== 親負担増 =====

              if (!y.dealer) {
                const share = total / 3
                others.forEach(p => {
                  result[p] -= share
                })
                return
              }

              others.forEach(p => {
                if (p === y.dealer) {
                  // 親
                  result[p] -= YAKUMAN_TSUMO_CHILD_PARENT * y.count
                } else {
                  // 子
                  result[p] -= YAKUMAN_TSUMO_CHILD_CHILD * y.count
                }
              })
            }
          }
        }

      })
    }


  })

  return result
}

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
  rounds: Round[],
  settlement: Settlement
) {
  const totalPt = Object.fromEntries(
    PLAYERS.map(p => [p, 0])
  ) as Record<Player, number>

  rounds.forEach(round => {
    recalcRound(round.scores).forEach(r => {
      totalPt[r.player] += r.point
    })
  })

  const rate = settlement.rateYenPerPt
  const tableShare = settlement.tableFee / 4

  const bonusPt = calcBonusPoints(rounds)

  return PLAYERS.map(player => {
    const total = totalPt[player] + bonusPt[player]
    const yen = total * rate

    const food = settlement.foodFee[player] ?? 0
    const final = yen - tableShare - food

    return {
      player,
      pt: total,
      final,
    }
  })
}

function Mark({
  label,
  value,
}: {
  label: string
  value: number
}) {
  if (value === 0) return null

  const color = value > 0 ? "#2e7d32" : "#c62828"

  return (
    <span
      style={{
        display: "inline-block",
        minWidth: "12px",
        height: "12px",
        lineHeight: "12px",
        borderRadius: "50%",
        border: `1px solid ${color}`,
        color,
        textAlign: "center",
        fontSize: "8px",
        marginLeft: "1px",
        verticalAlign: "middle",
        opacity: 0.85,
        fontWeight: "bold",
      }}
    >
      {label}
    </span>

  )
}

/* ========= UI ========= */

type ScoreTableProps = {
  rounds: Round[]
  players: Player[]

  mode: Mode
  activeRoundIndex: number | null

  setMode: React.Dispatch<React.SetStateAction<Mode>>
  setActiveRoundIndex: React.Dispatch<
    React.SetStateAction<number | null>
  >

  loadRoundToUI: (round: Round) => void

  allResults: RoundResult[][]
}

function ScoreTable({
  rounds,
  allResults,
  players,
  mode,
  activeRoundIndex,
  setMode,
  setActiveRoundIndex,
  loadRoundToUI
}: ScoreTableProps) {
  return (

    <table
      style={{
        borderCollapse: "collapse",
        width: "100%",
        marginTop: "8px",
      }}
    >
      <thead>
        <tr>
          <th style={{
            border: "1px solid #ccc",
            padding: "2px",
            width: "30px"
          }}>
          </th>
          {players.flatMap(player => ([
            <th
              key={`${player}-score`}
              style={{
                border: "1px solid #ccc",
                padding: "2px",
                width: "60px"
              }}
            >
              {player}
            </th>,
            <th
              key={`${player}-mark`}
              style={{
                border: "1px solid #ccc",
                padding: "2px",
                width: "36px"
              }}
            >
            </th>
          ]))}

          <th style={{
            border: "1px solid #ccc",
            padding: "2px",
            width: "80px"
          }}>
            操作
          </th>
        </tr>
      </thead>

      <tbody>
        {rounds.map((round, index) => {
          const results = allResults[index] ?? []

          const resultMap = Object.fromEntries(results.map(r => [r.player, r]))

          return (
            <tr
              key={`round-${index}`}
              style={{
                backgroundColor:
                  mode !== "idle" && activeRoundIndex === index
                    ? mode === "edit"
                      ? "#fffbe6"
                      : "#ffeaea"
                    : undefined,
              }}
            >
              <td style={{
                border: "1px solid #ccc",
                padding: "2px",
                width: "30px",
                textAlign: "center",
                whiteSpace: "nowrap"
              }}>
                {index + 1}
              </td>

              {players.map(player => {
                const r = resultMap[player]
                const point = r ? r.point : 0

                return [

                  // ✅ 数字セル
                  <td
                    key={`${player}-score`}
                    style={{
                      border: "1px solid #ccc",
                      padding: "2px",
                      textAlign: "right",
                      color: point < 0 ? "red" : "green",
                      width: "60px"
                    }}
                  >
                    {r ? point.toFixed(1) : ""}
                  </td>,

                  // ✅ マークセル（複数OK）
                  <td
                    key={`${player}-mark`}
                    style={{
                      border: "1px solid #ccc",
                      padding: "2px",
                      whiteSpace: "nowrap",
                      width: "36px"
                    }}
                  >
                    {round.events?.tobashi?.map((t, i) => {
                      if (t.by === player)
                        return <Mark key={`t-${player}-plus-${index}-${i}`} label="飛" value={1} />
                      if (t.targets.includes(player))
                        return <Mark key={`t-${player}-minus-${index}-${i}`} label="飛" value={-1} />
                      return null
                    })}

                    {round.events?.yakuman?.map((y, i) => {
                      if (y.directPoints !== undefined) {
                        const val = y.directPoints[player] ?? 0
                        if (val > 0)
                          return <Mark key={`y-${player}-plus-${index}-${i}`} label="役" value={1} />
                        if (val < 0)
                          return <Mark key={`y-${player}-minus-${index}-${i}`} label="役" value={-1} />
                        return null
                      }

                      if (y.winner === player)
                        return <Mark key={`y-${player}-win-${index}-${i}`} label="役" value={1} />
                      if (y.discarder === player || y.responsibility === player)
                        return <Mark key={`y-${player}-lose-${index}-${i}`} label="役" value={-1} />

                      return null
                    })}
                  </td>
                ]

              })}

              <td
                style={{
                  border: "1px solid #ccc",
                  padding: "2px",
                  textAlign: "center",
                  width: "80px"
                }}
              >

                {/* idle のときだけ 修正・削除 */}
                {mode === "idle" && (
                  <>

                    <button
                      style={{
                        padding: "2px 4px",
                        fontSize: "12px",
                        marginRight: "2px"
                      }}
                      onClick={() => {
                        setMode("edit")
                        setActiveRoundIndex(index)
                        loadRoundToUI(round)
                      }}
                    >
                      修正
                    </button>
                  </>
                )}

                {/* 修正中 */}
                {mode === "edit" && activeRoundIndex === index && (
                  <span style={{ color: "#b58900" }}>修正中</span>
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
              padding: "2px",
              fontWeight: "bold",
            }}
          >
            合計
          </td>

          {players.map(player => {

            const totalPoint = allResults.reduce((sum, results) => {
              const map = Object.fromEntries(results.map(r => [r.player, r]))
              const r = map[player]
              return sum + (r ? r.point : 0)
            }, 0)

            return [
              // 数字セル
              <td
                key={`${player}-score`}
                style={{
                  border: "1px solid #ccc",
                  borderTop: "2px solid #666",
                  padding: "2px",
                  fontWeight: "bold",
                  textAlign: "right",
                  color: totalPoint < 0 ? "red" : "green",
                }}
              >
                {totalPoint.toFixed(1)}
              </td>,

              // 順位セル（あとで使う）
              <td
                key={`${player}-rank`}
                style={{
                  border: "1px solid #ccc",
                  borderTop: "2px solid #666",
                  padding: "2px",
                }}
              >
              </td>
            ]

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

  )
}

type InputSectionProps = {
  players: Player[]

  inputScores: Record<Player, ScoreState>
  setInputScores: React.Dispatch<
    React.SetStateAction<Record<Player, ScoreState>>
  >

  firstInputRef: React.RefObject<HTMLInputElement | null>

  mode: Mode
  setMode: React.Dispatch<React.SetStateAction<Mode>>

  setActiveRoundIndex: React.Dispatch<
    React.SetStateAction<number | null>
  >

  emptyScores: Record<Player, ScoreState>

  validateYakumanInput: () => boolean
  buildEvents: () => Round["events"]
  normalizeScores: (
    scores: Record<Player, ScoreState>
  ) => Record<Player, ScoreState>

  setCurrentSession: React.Dispatch<
    React.SetStateAction<Session | null>
  >

  setSessions: React.Dispatch<
    React.SetStateAction<Session[]>
  >

  resetYakumanState: () => void

  activeRoundIndex: number | null

  deleteRound: () => void
}

function InputSection({
  players,
  inputScores,
  setInputScores,
  firstInputRef,
  mode,
  setMode,
  setActiveRoundIndex,
  emptyScores,
  validateYakumanInput,
  buildEvents,
  normalizeScores,
  setCurrentSession,
  setSessions,
  resetYakumanState,
  activeRoundIndex,
  deleteRound
}: InputSectionProps) {
  return (

    <table
      style={{
        borderCollapse: "collapse",
        width: "100%",
        marginTop: "8px",
        backgroundColor: "#f9f9f9",
        tableLayout: "fixed",
      }}
    >

      <tbody>
        <tr>
          {/* 行ラベル */}
          <td
            style={{
              border: "1px solid #ccc",
              padding: "2px",
              fontWeight: "bold",
              width: "40px",
              whiteSpace: "nowrap", 
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
                padding: "2px",
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
                style={{ width: "56px" }}
              />
            </td>
          ))}

          <td
            style={{
              border: "1px solid #ccc",
              padding: "2px",
              textAlign: "center",
              width: "80px",
              whiteSpace: "nowrap"
            }}
          >
            <>
              {/* === キャンセル（edit / delete のときだけ表示） === */}
              {mode === "edit" && (
                <button
                  onClick={() => {
                    setMode("idle")
                    setActiveRoundIndex(null)
                    setInputScores(emptyScores)

                    // ★ 祝儀UIの状態もリセット
                    resetYakumanState()
                  }}
                  style={{
                    marginRight: "6px",
                    padding: "2px 4px",
                    fontSize: "12px"
                  }}
                >
                  取り消し
                </button>
              )}

              {/* === 確定 === */}
              <button
                onClick={() => {
                  // ===== 新規追加 =====
                  if (mode === "idle") {

                    if (!validateYakumanInput()) return

                    const events = buildEvents()
                    const normalized = normalizeScores(inputScores)

                    // ✅ イベントがあるか安全に判定
                    const hasEvents =
                      !!(events?.tobashi?.length || events?.yakuman?.length)

                    setCurrentSession(prev => {
                      if (!prev) return prev

                      const round: Round =
                        hasEvents
                          ? { scores: normalized, events }
                          : { scores: normalized }

                      const updated = {
                        ...prev,
                        rounds: [...prev.rounds, round],
                      }

                      // ✅ sessions 側も必ず更新
                      setSessions(sessions =>
                        sessions.map(s => (s.id === updated.id ? updated : s))
                      )

                      return updated
                    })

                    setInputScores(emptyScores)

                    // ★ 祝儀UIの状態もリセット
                    resetYakumanState()

                    return
                  }

                  // ===== 修正確定 =====
                  if (mode === "edit" && activeRoundIndex !== null) {

                    if (!validateYakumanInput()) return

                    const events = buildEvents()
                    const normalized = normalizeScores(inputScores)

                    // ✅ eventsが実際にあるか安全に判定
                    const hasEvents =
                      !!(events?.tobashi?.length || events?.yakuman?.length)

                    setCurrentSession(prev => {
                      if (!prev || activeRoundIndex === null) return prev

                      const round: Round =
                        hasEvents
                          ? { scores: normalized, events }
                          : { scores: normalized }

                      const updated = {
                        ...prev,
                        rounds: prev.rounds.map((r, i) =>
                          i === activeRoundIndex
                            ? round
                            : r
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

                    // ★ 祝儀UIの状態もリセット
                    resetYakumanState()

                    return
                  }

                }}

                style={{
                  marginRight: "6px",
                  padding: "2px 4px",
                  fontSize: "12px"
                }}
              >
                {mode === "idle" && "確定"}
                {mode === "edit" && "修正確定"}
              </button>

              {mode === "edit" && (
                <button
                  onClick={deleteRound}
                  style={{
                    marginRight: "6px",
                    padding: "2px 4px",
                    fontSize: "12px",
                    color: "red"
                  }}
                >
                  削除確定
                </button>
              )}
            </>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

type BonusSectionProps = {
  players: Player[]

  showTobashi: boolean
  setShowTobashi: React.Dispatch<React.SetStateAction<boolean>>
  tobashiBy: Player | ""
  setTobashiBy: React.Dispatch<React.SetStateAction<Player | "">>
  tobashiTargets: Player[]
  setTobashiTargets: React.Dispatch<React.SetStateAction<Player[]>>

  showYakuman: boolean
  setShowYakuman: React.Dispatch<React.SetStateAction<boolean>>

  yakumanWinner: Player | null
  setYakumanWinner: React.Dispatch<React.SetStateAction<Player | null>>

  yakumanDealer: Player | ""
  setYakumanDealer: React.Dispatch<React.SetStateAction<Player | "">>

  yakumanTypeKey: string | null
  setYakumanTypeKey: React.Dispatch<React.SetStateAction<string | null>>

  yakumanType: "tsumo" | "ron"
  setYakumanType: React.Dispatch<React.SetStateAction<"tsumo" | "ron">>

  yakumanRole: "parent" | "child"
  setYakumanRole: React.Dispatch<React.SetStateAction<"parent" | "child">>

  yakumanDiscarder: Player | ""
  setYakumanDiscarder: React.Dispatch<React.SetStateAction<Player | "">>

  yakumanResponsibility: Player | ""
  setYakumanResponsibility: React.Dispatch<React.SetStateAction<Player | "">>

  yakumanMemo: string
  setYakumanMemo: React.Dispatch<React.SetStateAction<string>>

  yakumanAdjustMap: Record<Player, number | "">
  setYakumanAdjustMap: React.Dispatch<
    React.SetStateAction<Record<Player, number | "">>
  >

  selectedYakumanType: YakumanType | null

  needResponsibility: boolean
}

function BonusSection({
  players,
  showTobashi,
  setShowTobashi,
  tobashiBy,
  setTobashiBy,
  tobashiTargets,
  setTobashiTargets,
  showYakuman,
  setShowYakuman,
  yakumanWinner,
  setYakumanWinner,
  yakumanDealer,
  setYakumanDealer,
  yakumanTypeKey,
  setYakumanTypeKey,
  yakumanType,
  setYakumanType,
  yakumanRole,
  setYakumanRole,
  yakumanDiscarder,
  setYakumanDiscarder,
  yakumanResponsibility,
  setYakumanResponsibility,
  yakumanMemo,
  setYakumanMemo,
  yakumanAdjustMap,
  setYakumanAdjustMap,
  selectedYakumanType,
  needResponsibility
}: BonusSectionProps) {
  return (
    <>
      {/* === 飛ばし祝儀トグル === */}
      <div
        style={{ cursor: "pointer", marginTop: "12px" }}
        onClick={() => setShowTobashi(prev => !prev)}
      >
        {showTobashi ? "− 飛ばし祝儀を入力する" : "+ 飛ばし祝儀を入力する"}
      </div>

      {showTobashi && (
        <div style={{ marginLeft: "16px", marginTop: "8px" }}>
          {/* 飛ばした人 */}
          <div style={{ marginBottom: "8px" }}>
            飛ばした人：
            <select
              value={tobashiBy}
              onChange={e => setTobashiBy(e.target.value as Player)}
              style={{ marginLeft: "8px" }}
            >
              <option value="">選択</option>
              {players.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* 飛ばされた人 */}
          <div>
            飛ばされた人：
            {players.map(p => (
              <label key={p} style={{ marginLeft: "8px" }}>
                <input
                  type="checkbox"
                  checked={tobashiTargets.includes(p)}
                  onChange={e => {
                    if (e.target.checked) {
                      setTobashiTargets(prev => [...prev, p])
                    } else {
                      setTobashiTargets(prev => prev.filter(x => x !== p))
                    }
                  }}
                />
                {p}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* === 役満祝儀トグル === */}
      <div
        style={{ cursor: "pointer", marginTop: "12px" }}
        onClick={() => setShowYakuman(prev => !prev)}
      >
        {showYakuman ? "− 役満祝儀を入力する" : "+ 役満祝儀を入力する"}
      </div>

      {showYakuman && (
        <div style={{ marginLeft: "16px", marginTop: "8px" }}>
          {/* 和了者 */}
          <div style={{ marginBottom: "8px" }}>
            和了者：
            <select
              value={yakumanWinner ?? ""}
              onChange={e => {
                const value = e.target.value as Player | ""

                if (value === "") {
                  // 和了者を外した = 役満祝儀を使わない
                  setYakumanWinner(null)
                  setYakumanTypeKey(null)
                } else {
                  // 和了者を選んだ = 役満祝儀が発生
                  setYakumanWinner(value)
                  setYakumanTypeKey("yakuman") // ★ここで初めてデフォルトを入れる
                }
              }}
              style={{ marginLeft: "8px" }}
            >
              <option value="">選択</option>
              {players.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          {/* 親／子 */}
          <div style={{ marginBottom: "8px" }}>
            親／子：
            <label style={{ marginLeft: "8px" }}>
              <input
                type="radio"
                checked={yakumanRole === "parent"}
                onChange={() => setYakumanRole("parent")}
              />
              親
            </label>
            <label style={{ marginLeft: "8px" }}>
              <input
                type="radio"
                checked={yakumanRole === "child"}
                onChange={() => setYakumanRole("child")}
              />
              子
            </label>
          </div>

          {/* 役満回数 */}
          <div style={{ marginBottom: "8px" }}>
            役満種別：
            <select
              value={yakumanTypeKey ?? ""}
              onChange={e => setYakumanTypeKey(e.target.value)}
              style={{ marginLeft: "8px" }}
            >
              <option value="">選択</option>
              {YAKUMAN_TYPES.map(t => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* 和了形 */}
          <div style={{ marginBottom: "8px" }}>
            和了形：
            <label style={{ marginLeft: "8px" }}>
              <input
                type="radio"
                checked={yakumanType === "tsumo"}
                onChange={() => setYakumanType("tsumo")}
              />
              ツモ
            </label>
            <label style={{ marginLeft: "8px" }}>
              <input
                type="radio"
                checked={yakumanType === "ron"}
                onChange={() => setYakumanType("ron")}
              />
              ロン
            </label>
          </div>

          {showYakuman &&
            yakumanWinner &&
            yakumanType === "tsumo" &&
            yakumanRole === "child" &&
            USE_PARENT_EXTRA && (
              <div style={{ marginBottom: "8px" }}>
                その時の親：
                <select
                  value={yakumanDealer ?? ""}
                  onChange={e =>
                    setYakumanDealer(e.target.value as Player)
                  }
                  style={{ marginLeft: "8px" }}
                >
                  <option value="">選択</option>
                  {players.map(p => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            )}

          {/* 放銃者（ロン時のみ） */}
          {yakumanType === "ron" && (
            <div style={{ marginBottom: "8px" }}>
              放銃者：
              <select
                value={yakumanDiscarder}
                onChange={e => setYakumanDiscarder(e.target.value as Player)}
                style={{ marginLeft: "8px" }}
              >
                <option value="">選択</option>
                {players.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* 責任払い対象 */}
          {yakumanWinner && needResponsibility && (
            <div style={{ marginBottom: "8px" }}>
              責任払い対象：
              <select
                value={yakumanResponsibility}
                onChange={e => setYakumanResponsibility(e.target.value as Player)}
                style={{ marginLeft: "8px" }}
              >
                <option value="">なし</option>
                {players.map(p => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* メモ欄 */}
          {yakumanWinner && (
            <div style={{ marginBottom: "8px" }}>
              メモ：
              <input
                type="text"
                value={yakumanMemo}
                onChange={e => setYakumanMemo(e.target.value)}
                maxLength={20}
                style={{ marginLeft: "8px", width: "260px" }}
              />
            </div>
          )}

          {/* 手動祝儀入力 */}
          {selectedYakumanType &&
            selectedYakumanType.directAdjust === 1 && (
              <div style={{ marginBottom: "8px" }}>
                祝儀ポイント（直接入力）：
                {players.map(p => (
                  <div key={p}>
                    {p}：
                    <input
                      type="number"
                      value={yakumanAdjustMap[p]}
                      onChange={e =>
                        setYakumanAdjustMap(prev => ({
                          ...prev,
                          [p]: e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                      style={{ marginLeft: "8px", width: "80px" }}
                    />
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      <hr
        style={{
          margin: "32px 0",
          border: "none",
          borderTop: "2px solid #999",
        }}
      />
    </>
  )
}

function App() {

  /* ========= セッション・データ状態 ========= */
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSession, setCurrentSession] = useState<Session | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)

  /* ========= 画面操作用の状態（初期データ） ========= */
  const emptyScores = Object.fromEntries(
    PLAYERS.map(p => [
      p,
      { value: "", updatedAt: null }
    ])
  ) as Record<Player, ScoreState>

  /* ========= 画面操作用の状態 ========= */
  const [mode, setMode] = useState<Mode>("idle")
  const [activeRoundIndex, setActiveRoundIndex] = useState<number | null>(null)

  const [showTobashi, setShowTobashi] = useState(false)
  const [tobashiBy, setTobashiBy] = useState<Player | "">("")
  const [tobashiTargets, setTobashiTargets] = useState<Player[]>([])

  const [showYakuman, setShowYakuman] = useState(false)
  const [yakumanWinner, setYakumanWinner] = useState<Player | null>(null)
  const [yakumanDealer, setYakumanDealer] = useState<Player | "">("")
  const [yakumanTypeKey, setYakumanTypeKey] = useState<string | null>(null)
  const [yakumanType, setYakumanType] = useState<"tsumo" | "ron">("tsumo")
  const [yakumanRole, setYakumanRole] = useState<"parent" | "child">("child")
  const [yakumanDiscarder, setYakumanDiscarder] = useState<Player | "">("")
  const [yakumanResponsibility, setYakumanResponsibility] = useState<Player | "">("")
  const [yakumanMemo, setYakumanMemo] = useState("")

  function createEmptyAdjustMap() {
    return Object.fromEntries(
      PLAYERS.map(p => [p, ""])
    ) as Record<Player, number | "">
  }

  const [yakumanAdjustMap, setYakumanAdjustMap] =
    useState<Record<Player, number | "">>(createEmptyAdjustMap())

  /* ========= 画面操作用の状態（補助） ========= */
  // Sessionタイトル編集用
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")

  // 入力欄に表示するスコア（新規 / 修正 / 削除確認 共通）
  const [inputScores, setInputScores] =
    useState<Record<Player, ScoreState>>(emptyScores)

  const firstInputRef = useRef<HTMLInputElement | null>(null)

  /* ========= 派生データ ========= */
  const rounds = currentSession?.rounds ?? []
  const allResults = useMemo(() => {
    if (!currentSession) return []
    return currentSession.rounds.map(round =>
      recalcRound(round.scores)
    )
  }, [currentSession])

  const settlementResults = useMemo(() => {
    if (!currentSession) return []
    return calcSettlement4p(
      currentSession.rounds,
      currentSession.settlement
    )
  }, [currentSession])

  const selectedYakumanType =
    YAKUMAN_TYPES.find(t => t.key === yakumanTypeKey) ?? null

  const needResponsibility =
    selectedYakumanType ? selectedYakumanType.responsibility === 1 : false

  /* ========= 自動処理（useEffect） ========= */
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

  /* ========= 初期ロード制御 ========= */

  const bonusPt = useMemo(() => {
    if (!currentSession) {
      return Object.fromEntries(
        PLAYERS.map(p => [p, 0])
      ) as Record<Player, number>
    }

    return calcBonusPoints(currentSession.rounds)
  }, [currentSession])


  if (!hasLoaded) {
    return <div style={{ padding: "16px" }}>Loading...</div>
  }

  /* ========= 処理関数 ========= */
  function deleteRound() {
    if (activeRoundIndex === null) return

    setCurrentSession(prev => {
      if (!prev) return prev

      const updated = {
        ...prev,
        rounds: prev.rounds.filter((_, i) => i !== activeRoundIndex),
      }

      setSessions(sessions =>
        sessions.map(s => (s.id === updated.id ? updated : s))
      )

      return updated
    })

    // 状態リセット
    setMode("idle")
    setActiveRoundIndex(null)
    setInputScores(emptyScores)
    resetYakumanState()
  }

  function resetYakumanState() {
    setShowTobashi(false)
    setShowYakuman(false)

    setTobashiBy("")
    setTobashiTargets([])

    setYakumanWinner(null)
    setYakumanDealer("")
    setYakumanTypeKey(null)
    setYakumanType("tsumo")
    setYakumanRole("child")
    setYakumanDiscarder("")
    setYakumanResponsibility("")
    setYakumanMemo("")
    setYakumanAdjustMap(createEmptyAdjustMap())
  }

  function validateDirectPoints(map: Record<Player, number | "">): string | null {
    const values = PLAYERS.map(p =>
      Number(map[p] || 0)
    )

    const sum = values.reduce((a, b) => a + b, 0)

    // 合計0チェック
    if (sum !== 0) {
      return "祝儀ポイントの合計は0にしてください"
    }

    // プラス人数チェック
    const positiveCount = values.filter(v => v > 0).length
    if (positiveCount !== 1) {
      return "プラスは1人だけにしてください"
    }

    return null
  }

  // 祝儀入力のバリデーション共通化
  function validateYakumanInput(): boolean {
    if (
      yakumanWinner &&
      selectedYakumanType &&
      selectedYakumanType.directAdjust === 1
    ) {
      const error = validateDirectPoints(yakumanAdjustMap)
      if (error) {
        alert(error)
        return false
      }
    }
    return true
  }

  // イベント生成を共通化
  function buildEvents(): Round["events"] {
    const events: Round["events"] = {}

    if (tobashiBy && tobashiTargets.length > 0) {
      events.tobashi = [{
        by: tobashiBy,
        targets: tobashiTargets
      }]
    }

    if (yakumanWinner && yakumanTypeKey) {
      const selected = YAKUMAN_TYPES.find(t => t.key === yakumanTypeKey)

      if (selected) {
        events.yakuman = [{
          winner: yakumanWinner,
          key: yakumanTypeKey,
          count: selected.count,
          type: yakumanType,
          role: yakumanRole,
          dealer: yakumanDealer || undefined,
          discarder:
            yakumanType === "ron" && yakumanDiscarder
              ? yakumanDiscarder
              : undefined,
          responsibility:
            needResponsibility && yakumanResponsibility
              ? yakumanResponsibility
              : undefined,
          memo: yakumanMemo || undefined,
          directPoints:
            selected.directAdjust === 1
              ? Object.fromEntries(
                PLAYERS.map(p => [p, Number(yakumanAdjustMap[p] || 0)])
              ) as Record<Player, number>
              : undefined
        }]
      }
    }

    return events
  }

  function loadRoundToUI(round: Round) {
    // 点数
    setInputScores(round.scores)

    const events = round.events

    // ===== 飛ばし祝儀 =====
    if (events?.tobashi?.[0]) {
      const tobashi = events.tobashi[0]
      setShowTobashi(true)
      setTobashiBy(tobashi.by)
      setTobashiTargets(tobashi.targets)
    }

    // ===== 役満祝儀 =====
    if (events?.yakuman?.[0]) {
      const y = events.yakuman[0]

      setShowYakuman(true)
      setYakumanWinner(y.winner)
      setYakumanTypeKey(y.key)
      setYakumanDealer(y.dealer ?? "")
      setYakumanType(y.type)
      setYakumanRole(y.role)
      setYakumanDiscarder(y.discarder ?? "")
      setYakumanResponsibility(y.responsibility ?? "")
      setYakumanMemo(y.memo ?? "")

      if (y.directPoints !== undefined) {
        setYakumanAdjustMap(
          Object.fromEntries(
            PLAYERS.map(p => [
              p,
              y.directPoints?.[p] ?? ""
            ])
          ) as Record<Player, number | "">
        )
      } else {
        setYakumanAdjustMap(createEmptyAdjustMap())
      }
    }
  }

  /* ========= 画面描画 ========= */
  const players = PLAYERS

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
              rateYenPerPt: 50, // デフォルト50円/pt
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

          // ★ 祝儀UIの状態もリセット
          resetYakumanState()

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

                // ★ 祝儀UIの状態もリセット
                resetYakumanState()
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

          <ScoreTable
            rounds={rounds}
            allResults={allResults}
            players={players}
            mode={mode}
            activeRoundIndex={activeRoundIndex}
            setMode={setMode}
            setActiveRoundIndex={setActiveRoundIndex}
            loadRoundToUI={loadRoundToUI}
          />

          {/* ④ 入力中の半荘 */}
          <h3 style={{ color: "#333" }}>入力中の半荘</h3>

          <InputSection
            players={players}
            inputScores={inputScores}
            setInputScores={setInputScores}
            firstInputRef={firstInputRef}
            mode={mode}
            setMode={setMode}
            setActiveRoundIndex={setActiveRoundIndex}
            emptyScores={emptyScores}
            validateYakumanInput={validateYakumanInput}
            buildEvents={buildEvents}
            normalizeScores={normalizeScores}
            setCurrentSession={setCurrentSession}
            setSessions={setSessions}
            resetYakumanState={resetYakumanState}
            activeRoundIndex={activeRoundIndex}
            deleteRound={deleteRound}
          />

          <BonusSection
            players={players}
            showTobashi={showTobashi}
            setShowTobashi={setShowTobashi}
            tobashiBy={tobashiBy}
            setTobashiBy={setTobashiBy}
            tobashiTargets={tobashiTargets}
            setTobashiTargets={setTobashiTargets}
            showYakuman={showYakuman}
            setShowYakuman={setShowYakuman}
            yakumanWinner={yakumanWinner}
            setYakumanWinner={setYakumanWinner}
            yakumanDealer={yakumanDealer}
            setYakumanDealer={setYakumanDealer}
            yakumanTypeKey={yakumanTypeKey}
            setYakumanTypeKey={setYakumanTypeKey}
            yakumanType={yakumanType}
            setYakumanType={setYakumanType}
            yakumanRole={yakumanRole}
            setYakumanRole={setYakumanRole}
            yakumanDiscarder={yakumanDiscarder}
            setYakumanDiscarder={setYakumanDiscarder}
            yakumanResponsibility={yakumanResponsibility}
            setYakumanResponsibility={setYakumanResponsibility}
            yakumanMemo={yakumanMemo}
            setYakumanMemo={setYakumanMemo}
            yakumanAdjustMap={yakumanAdjustMap}
            setYakumanAdjustMap={setYakumanAdjustMap}
            selectedYakumanType={selectedYakumanType}
            needResponsibility={needResponsibility}
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

          <h3 style={{ marginTop: "20px" }}>祝儀pt</h3>
          <table style={{ borderCollapse: "collapse", marginTop: "8px" }}>
            <tbody>
              <tr>
                {players.map(player => (
                  <td
                    key={player}
                    style={{
                      border: "1px solid #ccc",
                      padding: "6px 10px",
                      textAlign: "center",
                      color: bonusPt[player] < 0 ? "red" : "green",
                    }}
                  >
                    {player}：{bonusPt[player]}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>

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
              {settlementResults.map(r => {
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
