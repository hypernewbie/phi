" Phi Gold Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_gold"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#f3e5ab gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#f3e5ab
hi IncSearch        guifg=#14141a guibg=#d4af37
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#f3e5ab guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#f3e5ab guibg=#1f1f26  gui=bold
hi Directory        guifg=#d4af37

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#f3e5ab
hi String           guifg=#fbf5df
hi Character        guifg=#fbf5df
hi Number           guifg=#f3e5ab
hi Boolean          guifg=#f3e5ab
hi Float            guifg=#f3e5ab

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#d4af37

hi Statement        guifg=#f3e5ab gui=bold
hi Conditional      guifg=#f3e5ab gui=bold
hi Repeat           guifg=#f3e5ab gui=bold
hi Label            guifg=#f3e5ab
hi Operator         guifg=#d4af37
hi Keyword          guifg=#f3e5ab gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#997a15
hi Include          guifg=#997a15
hi Define           guifg=#997a15
hi Macro            guifg=#997a15
hi PreCondit        guifg=#997a15

hi Type             guifg=#997a15 gui=bold
hi StorageClass     guifg=#997a15
hi Structure        guifg=#997a15
hi Typedef          guifg=#997a15

hi Special          guifg=#f3e5ab
hi SpecialChar      guifg=#fbf5df
hi Tag              guifg=#d4af37
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#d4af37    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#f3e5ab  guibg=#1f1f26  gui=bold
