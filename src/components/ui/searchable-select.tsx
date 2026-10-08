import { useState, type ComponentProps } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type SearchableSelectProps = Pick<
  ComponentProps<typeof Button>,
  'id' | 'disabled' | 'aria-invalid' | 'aria-describedby'
> & {
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  searchLabel: string
  searchPlaceholder: string
  emptyMessage: string
}

export function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder,
  searchLabel,
  searchPlaceholder,
  emptyMessage,
  disabled,
  ...props
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.value === value)

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          {...props}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open && !disabled}
          disabled={disabled}
          className="w-full min-w-0 justify-between"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              setOpen(true)
            }
          }}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label={searchLabel}
        className="w-(--radix-popover-trigger-width) max-w-(--radix-popover-content-available-width) p-0"
      >
        <Command
          className="min-h-0"
          label={searchLabel}
          filter={(value, search, keywords = []) => {
            const text = [value, ...keywords].join(' ').toLocaleLowerCase()
            return search
              .trim()
              .toLocaleLowerCase()
              .split(/\s+/)
              .every((term) => text.includes(term))
              ? 1
              : 0
          }}
          loop
        >
          <CommandInput aria-label={searchLabel} placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>
              <span role="status">{emptyMessage}</span>
            </CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label]}
                  data-checked={option.value === value}
                  onSelect={() => {
                    if (option.value !== value) onValueChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 wrap-anywhere">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
