" Phi Blue Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_blue"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#7dd3fc gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a  guibg=#7dd3fc
hi IncSearch        guifg=#14141a  guibg=#38bdf8
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#7dd3fc guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#7dd3fc guibg=#1f1f26  gui=bold
hi Directory        guifg=#38bdf8

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#7dd3fc
hi String           guifg=#bae6fd
hi Character        guifg=#bae6fd
hi Number           guifg=#7dd3fc
hi Boolean          guifg=#7dd3fc
hi Float            guifg=#7dd3fc

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#38bdf8

hi Statement        guifg=#7dd3fc gui=bold
hi Conditional      guifg=#7dd3fc gui=bold
hi Repeat           guifg=#7dd3fc gui=bold
hi Label            guifg=#7dd3fc
hi Operator         guifg=#38bdf8
hi Keyword          guifg=#7dd3fc gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#0284c7
hi Include          guifg=#0284c7
hi Define           guifg=#0284c7
hi Macro            guifg=#0284c7
hi PreCondit        guifg=#0284c7

hi Type             guifg=#0284c7 gui=bold
hi StorageClass     guifg=#0284c7
hi Structure        guifg=#0284c7
hi Typedef          guifg=#0284c7

hi Special          guifg=#7dd3fc
hi SpecialChar      guifg=#bae6fd
hi Tag              guifg=#38bdf8
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#38bdf8    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#7dd3fc  guibg=#1f1f26  gui=bold
