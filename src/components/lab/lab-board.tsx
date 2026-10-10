'use client'

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { useRouter } from 'next/navigation'
import { useCallback, useState } from 'react'
import {
  COLUMN_PANEL, COLUMN_WIDTH, ColumnCount, DragPreview, DropList, laneTone,
} from '@/components/board-columns'
import { cn } from '@/lib/utils'
import { StageIcon } from './stage'
import { SubjectCard } from './subject-card'
import { useStageMove } from './use-stage-move'
import { isConcluding, type Stage, type Subject, type SubjectSummary } from './types'

const Draggable = ({ subject }: { subject: SubjectSummary }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: subject.id })
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="cursor-grab rounded-lg focus-visible:outline-accent/60 focus-visible:outline-2 focus-visible:outline-offset-1"
    >
      <SubjectCard subject={subject} dragging={isDragging} />
    </div>
  )
}

const Lane = ({ stage, subjects }: { stage: Stage; subjects: SubjectSummary[] }) => (
  <section
    aria-label={stage.name}
    className={cn(COLUMN_PANEL, 'h-full', COLUMN_WIDTH)}
    style={laneTone(stage.color)}
  >
    <div className="flex h-8 items-center gap-2 px-2.5">
      <StageIcon stage={stage} />
      <span className="text-fg truncate text-meta font-medium">{stage.name}</span>
      <ColumnCount count={subjects.length} />
    </div>
    <DropList dropId={stage.id} count={subjects.length} className="min-h-0 flex-1 overscroll-y-contain">
      {subjects.map((subject) => (
        <Draggable key={subject.id} subject={subject} />
      ))}
    </DropList>
  </section>
)

/**
 * The Lab as a board: one lane per stage, in the order an admin set. Dragging
 * a card to another lane moves the subject there; a lane that concludes (a
 * completed or dropped stage) asks for the conclusion first when there is none
 * yet, rather than firing a move the server would refuse.
 *
 * The scroll box is the same one the project board uses, so the board scrolls
 * sideways on a phone, with snap, and without it from `md` up.
 */
export const LabBoard = ({
  subjects: initial,
  stages,
}: {
  subjects: SubjectSummary[]
  stages: Stage[]
}) => {
  const router = useRouter()
  const [subjects, setSubjects] = useState(initial)
  // Adjusted during render rather than in an effect: a move an agent made, or
  // one the server settled differently, lands without a remount.
  const [prevInitial, setPrevInitial] = useState(initial)
  if (initial !== prevInitial) {
    setPrevInitial(initial)
    setSubjects(initial)
  }
  const [dragging, setDragging] = useState<SubjectSummary | null>(null)

  const onMoved = useCallback(
    (moved: Subject, stage: Stage) => {
      setSubjects((current) =>
        current.map((s) =>
          s.id === moved.id ? { ...s, stage, conclusion: moved.conclusion ?? s.conclusion } : s,
        ),
      )
      router.refresh()
    },
    [router],
  )
  const { move, dialog } = useStageMove(onMoved)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  )

  const onDragEnd = async ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over) return
    const subject = subjects.find((s) => s.id === active.id)
    const stage = stages.find((s) => s.id === over.id)
    if (!subject || !stage || subject.stage.id === stage.id) return

    const previous = subjects
    // Optimistic only where the move can land at once; a concluding lane waits
    // for its dialog, and the card stays where it was until that is answered.
    const asks = isConcluding(stage.category) && !subject.conclusion?.trim()
    if (!asks) setSubjects((current) => current.map((s) => (s.id === subject.id ? { ...s, stage } : s)))
    const outcome = await move(subject, stage)
    if (outcome !== 'moved') setSubjects(previous)
  }

  return (
    <>
      {/* A fixed id: dnd-kit numbers its aria-describedby from a module
          counter the server and the client do not share. */}
      <DndContext
        id="lab-board"
        sensors={sensors}
        onDragStart={({ active }: DragStartEvent) =>
          setDragging(subjects.find((s) => s.id === active.id) ?? null)
        }
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="scroll-visible h-full snap-x scroll-px-3 overflow-auto md:snap-none">
          <div className="flex h-full w-max gap-2.5 p-3">
            {stages.map((stage) => (
              <Lane
                key={stage.id}
                stage={stage}
                subjects={subjects.filter((s) => s.stage.id === stage.id)}
              />
            ))}
          </div>
        </div>
        <DragOverlay>{dragging ? <DragPreview title={dragging.title} /> : null}</DragOverlay>
      </DndContext>
      {dialog}
    </>
  )
}
